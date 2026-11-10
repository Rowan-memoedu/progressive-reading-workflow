import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BACKGROUND_FETCH_TRANSPORT,
  BrowserImportBroker
} from "./browser-import-broker.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-ir-browser-broker-"));
let now = Date.parse("2026-08-21T00:00:00.000Z");
try {
  const broker = new BrowserImportBroker({ stateRoot: root, now: () => now, leaseMs: 1000, retryDelayMs: 100, concurrency: 4 });
  const request = await broker.createRequest(["https://a.test/article", "https://b.test/article"], {
    source: "test",
    clientRequestId: "fixture-request-1",
    entryRoute: "ai",
    destinationFolder: "知乎/知乎点赞"
  });
  assert.equal(request.status, "queued");
  assert.equal(request.requested, 2);
  assert.equal(request.entry_route, "ai");
  assert.equal(request.destination_folder, "知乎/知乎点赞");
  const duplicateRequest = await broker.createRequest(["https://a.test/article", "https://b.test/article"], { source: "test", clientRequestId: "fixture-request-1" });
  assert.equal(duplicateRequest.request_id, request.request_id);
  assert.equal(duplicateRequest.requested, 2);

  const first = await broker.claimTask("worker-a", "claim-a");
  assert.equal(first.requested_url, "https://a.test/article");
  assert.equal(first.entry_route, "ai");
  assert.equal(first.destination_folder, "知乎/知乎点赞");
  const firstAgain = await broker.claimTask("worker-a", "claim-a");
  assert.equal(firstAgain.id, first.id);
  assert.equal(firstAgain.attempt, 1);
  await broker.completeTask(first.id, { ok: true, result: { final_url: first.requested_url, artifacts: { markdown: "a.md" } } });

  const second = await broker.claimTask("worker-a", "claim-b");
  now += 2000;
  const reclaimed = await broker.claimTask("worker-b", "claim-c");
  assert.equal(reclaimed.id, second.id, "expired claims must be recoverable");
  const completed = await broker.completeTask(reclaimed.id, { ok: false, error: "fixture_failure" });
  assert.equal(completed.status, "completed_with_failures");
  assert.equal(completed.imported, 1);
  assert.equal(completed.failed, 1);
  assert.deepEqual(completed.results.map((item) => item.status), ["imported", "failed"]);

  const retryRequest = await broker.createRequest(["https://retry.test/article"], { source: "test" });
  const retryFirst = await broker.claimTask("worker-a");
  assert.equal(retryFirst.attempt, 1);
  const requeued = await broker.completeTask(retryFirst.id, {
    ok: false,
    error: "transient_network_failure",
    retryable: true,
    leaseToken: retryFirst.lease_token
  });
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.results[0].attempt_count, 1);
  now += 101;
  const retrySecond = await broker.claimTask("worker-b");
  assert.equal(retrySecond.id, retryFirst.id);
  assert.equal(retrySecond.attempt, 2);
  await assert.rejects(
    broker.completeTask(retrySecond.id, { ok: true, leaseToken: retryFirst.lease_token }),
    /browser_import_task_stale_lease/
  );
  const retried = await broker.completeTask(retrySecond.id, {
    ok: true,
    result: { final_url: retrySecond.requested_url, artifacts: { markdown: "retry.md" } },
    leaseToken: retrySecond.lease_token
  });
  assert.equal(retried.status, "completed");
  assert.equal(retried.results[0].attempt_count, 2);

  const exhaustedRequest = await broker.createRequest(["https://retry.test/exhausted"], { source: "test" });
  let exhausted = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = await broker.claimTask(`worker-${attempt}`);
    assert.equal(claimed.attempt, attempt);
    exhausted = await broker.completeTask(claimed.id, {
      ok: false,
      error: `transient_${attempt}`,
      retryable: true,
      leaseToken: claimed.lease_token
    });
    if (attempt < 3) {
      assert.equal(exhausted.status, "queued");
      now += 100 * attempt + 1;
    }
  }
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.results[0].attempt_count, 3);

  const backgroundRequest = await broker.createRequest(["https://background.test/auth"], {
    source: "obsidian-test",
    clientRequestId: "background-fixture-1",
    transport: BACKGROUND_FETCH_TRANSPORT,
    userInstruction: "保留作者视角"
  });
  assert.equal(backgroundRequest.transport, BACKGROUND_FETCH_TRANSPORT);
  await assert.rejects(
    broker.claimTask("browser-worker", "browser-claim", { transport: "browser_auth_handoff" }),
    /browser_import_claim_transport_not_supported/
  );
  const backgroundTask = await broker.claimTask("local-background-worker", "background-claim", { transport: BACKGROUND_FETCH_TRANSPORT });
  assert.equal(backgroundTask.transport, BACKGROUND_FETCH_TRANSPORT);
  assert.equal(backgroundTask.user_instruction, "保留作者视角");
  const degraded = await broker.completeTask(backgroundTask.id, {
    ok: false,
    degradedStatus: "requires_browser_auth",
    error: "password_form_detected",
    result: {
      status: "requires_browser_auth",
      final_url: "https://background.test/login",
      cookies: ["private-cookie-must-not-persist"],
      source_metadata: { cookie: "private-cookie-must-not-persist", response_status: 200 },
      receipt: { browser_tab_created: false }
    },
    leaseToken: backgroundTask.lease_token
  });
  assert.equal(degraded.status, "requires_browser_auth");
  assert.equal(degraded.results[0].status, "requires_browser_auth");
  assert.equal(degraded.results[0].transport, BACKGROUND_FETCH_TRANSPORT);
  assert.equal(degraded.results[0].handoff_status, undefined);
  assert.equal(degraded.results[0].source_metadata.cookie, undefined);
  assert.doesNotMatch(await fs.readFile(path.join(root, "state.json"), "utf8"), /private-cookie-must-not-persist/);
  assert.equal(await broker.claimTask("local-background-worker", "terminal-check", { transport: BACKGROUND_FETCH_TRANSPORT }), null);

  const warningRequest = await broker.createRequest(["https://warning.test/article"], { source: "test" });
  const warningTask = await broker.claimTask("warning-worker");
  const warningSummary = await broker.completeTask(warningTask.id, {
    ok: true,
    result: {
      status: "imported_with_warnings",
      final_url: warningTask.requested_url,
      artifacts: [{ kind: "markdown", path: "warning.md" }],
      receipt: { quality_status: "warning", readable_with_warnings: true }
    },
    leaseToken: warningTask.lease_token
  });
  assert.equal(warningSummary.status, "completed_with_warnings");
  assert.equal(warningSummary.warnings, 1);
  assert.equal(warningSummary.concurrency, 1);
  assert.equal((await broker.findSuccessfulResultForUrl(warningTask.requested_url)).status, "imported_with_warnings");

  // An idle worker must yield when only another request has queued work.
  const waitingRequest = await broker.createRequest(["https://waiting.test/article"], { source: "test" });
  const claimedWaiting = await broker.claimTask("waiting-worker", null, { requestId: waitingRequest.request_id });
  const otherRequest = await broker.createRequest(["https://other.test/article"], { source: "test" });
  let timerRan = false;
  const tick = new Promise(resolve => setTimeout(() => { timerRan = true; resolve(); }, 0));
  await broker.waitForTask(20, { requestId: waitingRequest.request_id });
  assert.equal(timerRan, true, "unrelated queued work must not create a busy microtask loop");
  await tick;
  await broker.completeTask(claimedWaiting.id, { ok: true, leaseToken: claimedWaiting.lease_token });
  const otherTask = await broker.claimTask("other-worker", null, { requestId: otherRequest.request_id });
  await broker.completeTask(otherTask.id, { ok: true, leaseToken: otherTask.lease_token });

  const reloaded = new BrowserImportBroker({ stateRoot: root });
  const persisted = await reloaded.getRequest(request.request_id);
  assert.equal(persisted.status, "completed_with_failures");
  assert.equal(persisted.entry_route, "ai");
  assert.equal(persisted.destination_folder, "知乎/知乎点赞");
  assert.equal((await reloaded.getRequest(retryRequest.request_id)).status, "completed");
  assert.equal((await reloaded.getRequest(exhaustedRequest.request_id)).status, "failed");
  assert.equal(await reloaded.claimTask("worker-c"), null);

  console.log(JSON.stringify({ status: "passed", checks: ["durable_request", "idempotent_request_creation", "idempotent_task_claim", "claim", "completion", "lease_recovery", "mixed_batch_receipt", "bounded_retry", "retry_backoff", "retry_exhaustion", "stale_lease_rejection", "transport_isolation", "explicit_degraded_status", "readable_warning_status", "configured_concurrency", "cookie_field_redaction"] }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
