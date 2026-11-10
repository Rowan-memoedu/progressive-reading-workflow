const SUCCESS = new Set(["imported", "imported_with_warnings", "idempotent_replay"]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function collectionResult(task, collection) {
  const rows = collection.results || [];
  const warnings = rows.filter(row => row.status === "imported_with_warnings" || row.receipt?.quality_status === "warning").length;
  const failed = rows.filter(row => !SUCCESS.has(row.status)).length;
  const waiting = rows.filter(row => row.status === "needs_classification").length;
  const complete = collection.inventory?.complete && rows.length === collection.inventory.articles.length && failed === 0;
  return {
    requested_url: task.requested_url,
    status: waiting ? "needs_classification" : complete ? warnings ? "imported_with_warnings" : "imported" : "failed",
    collection,
    artifacts: rows.flatMap(row => row.artifacts || []).filter(artifact => artifact.kind === "markdown"),
    receipt: { processing_mode: "collection_import", rule_id: collection.rule_id,
      quality_status: complete ? warnings ? "warning" : "ready" : "failed", browser_tab_created: false,
      article_count: collection.inventory?.articles.length || 0, imported: rows.length - failed, warnings, failed },
    ...(collection.error ? { errors: [{ code: "collection_import_failed", message: collection.error }] } : {})
  };
}

// A collection is a durable parent task inside the existing broker. Article batches
// are ordinary broker requests, with stable ids and the existing worker/receipts.
export async function processCollectionTask(task, { broker, discover, runRequest, pollMs = 1000, initialCollection, onProgress, verify } = {}) {
  const collection = task.collection || initialCollection || { rule_id: "zhihu-column-all-articles", phase: "discovering", inventory: null, batches: [], results: [] };
  const progress = async () => { await broker.updateTaskProgress(task.id, { collection }, task.lease_token); await onProgress?.(collection); };
  try {
    if (!collection.inventory?.complete) {
      collection.phase = "discovering";
      await progress();
      collection.inventory = await discover(task.requested_url, async detail => { collection.discovery = detail;collection.phase=detail.phase || collection.phase; await progress(); });
      collection.phase = "importing";
      await progress();
    }
    const preserved = new Set(collection.results.filter(row=>SUCCESS.has(row.status)).map(row=>row.requested_url));
    // Freeze batch membership: completed rows must not shift later batches on resume.
    collection.batch_urls ||= collection.inventory.articles.map(article => article.url).filter(url=>collection.batches.length || !preserved.has(url));
    const urls = collection.batch_urls;
    for (let offset = 0; offset < urls.length; offset += 50) {
      const index = offset / 50;
      if (collection.batches[index]?.terminal) continue;
      const request = collection.batches[index]?.request_id ? await broker.getRequest(collection.batches[index].request_id) : await broker.createRequest(urls.slice(offset, offset + 50), {
        source: task.source, clientRequestId: `${task.id}:articles:${index}`,
        userInstruction: task.user_instruction, entryRoute: task.entry_route, destinationFolder: task.destination_folder,
        processingOptions: task.processing_options || {}, processingMode: task.processing_mode || "standard_preprocess",
        articleSource: collection.inventory.article_source || null
      });
      collection.batches[index] = { request_id: request.request_id, terminal: false };
      await progress();
      const execution = runRequest(request.request_id);
      // Consume rejection immediately while polling persisted child state.
      let executionError;
      const settled = execution.catch(error => { executionError = error; });
      let latest;
      do {
        if (executionError) throw executionError;
        latest = await broker.getRequest(request.request_id);
        if (!latest) throw new Error("collection_child_request_missing");
        const retained = new Map(collection.results.map(row => [row.requested_url, row]));
        for (const row of latest.results) retained.set(row.requested_url, row);
        collection.results = [...retained.values()];
        await progress();
        if (!latest.terminal) await wait(pollMs);
      } while (!latest.terminal);
      await settled;
      if (executionError) throw executionError;
      collection.batches[index].terminal = true;
      await progress();
    }
    if (verify) { collection.phase='verifying';await progress();collection.verification=await verify(collection); }
    collection.phase = "completed";
    const result = collectionResult(task, collection);
    const ok = SUCCESS.has(result.status);
    if (!ok) collection.phase = "completed_with_failures";
    if (result.status === "needs_classification") collection.phase = "needs_classification";
    await broker.completeTask(task.id, { ok, result, error: ok ? null : result.status === "needs_classification" ? "部分文章需要补充分类信息。" : "collection_articles_incomplete", degradedStatus: result.status === "needs_classification" ? "needs_classification" : null, leaseToken: task.lease_token });
    await onProgress?.(collection);
  } catch (error) {
    if(error.inventory)collection.inventory=error.inventory;
    collection.phase = "failed";
    collection.error = error.message;
    const result = collectionResult(task, collection);
    result.status = "failed";
    result.receipt.quality_status = "failed";
    await broker.completeTask(task.id, { ok: false, result, error: error.message,
      degradedStatus: error.status === "requires_browser_auth" || /zhihu_http_(401|403)|zhihu_cookie_not_synced|cookie_sync_stale_refresh_chrome/u.test(error.message) ? "requires_browser_auth" : null,
      leaseToken: task.lease_token });
    await onProgress?.(collection);
  }
}
