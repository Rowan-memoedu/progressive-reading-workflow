import { zhihuColumnIdentity } from "./import-rule-catalog.mjs";
import { requestZhihuJson } from "./zhihu-social-archive.mjs";
import { publicationDateFromSeconds } from "../subscription-workflow/publication-time.mjs";

function nextPage(value, id) {
  const url = new URL(value, 'https://zhuanlan.zhihu.com');
  const legacy = ['www.zhihu.com','zhuanlan.zhihu.com'].includes(url.hostname) && url.pathname === `/api/v4/columns/${id}/items`;
  const column = url.hostname === 'zhuanlan.zhihu.com' && url.pathname === `/api/columns/${id}/items`;
  if (!['http:','https:'].includes(url.protocol) || url.port || url.username || url.password || (!legacy && !column)) {
    throw new Error("zhihu_column_pagination_origin_invalid");
  }
  // Reuse the maintained RSSHub column endpoint. Server-provided HTTP cursors
  // are upgraded before any request, and authentication is matched again here.
  url.protocol = 'https:'; url.hostname = 'zhuanlan.zhihu.com'; url.pathname = `/api/columns/${id}/items`;
  url.hash = "";
  url.searchParams.sort();
  return url.href;
}

function itemIdentity(item) {
  if (!["article", "answer", "zvideo", "pin"].includes(item?.type)) throw new Error("zhihu_column_unknown_item_type");
  let id = typeof item?.id === "string" ? item.id : Number.isSafeInteger(item?.id) ? String(item.id) : "";
  if (!id && item.type === "article" && item.url) {
    try {
      const url = new URL(item.url);
      if (["zhuanlan.zhihu.com", "www.zhihu.com", "api.zhihu.com"].includes(url.hostname)) id = url.pathname.match(/^\/(?:p|articles)\/([0-9]+)\/?$/u)?.[1] || "";
    } catch { /* Keep invalid identities as explicit failures. */ }
  }
  if (!/^[0-9]+$/u.test(id)) throw new Error("zhihu_column_item_identity_invalid");
  return `${item.type}:${id}`;
}

export async function discoverZhihuColumn(value, { cookieHeaderForUrl, fetchImpl = fetch, onProgress = async () => {}, maxPages = 1000,
  strictCounts = true, includeAnswers = false, onWarning = async () => {} } = {}) {
  const column = zhihuColumnIdentity(value);
  if (!column) throw new Error("zhihu_column_url_invalid");
  const options = { cookieHeaderForUrl, retryDelaysMs: [],
    fetchImpl: (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(30000) }) };
  const articles = new Map();
  const materials = new Map(), observedTotals = new Set();
  const warnings = [];
  const listingItems = new Set();
  const excluded = new Map();
  const seenPages = new Set();
  let expectedTotal = null;
  let pages = 0;
  let pinnedCount = 0;
  const add = (item, fromList) => {
    const identity = itemIdentity(item);
    if (fromList) listingItems.add(identity);
    if (item.type === "article") {
      const id = identity.slice("article:".length);
      const publishedAt = publicationDateFromSeconds(item.created ?? item.created_time) ?? articles.get(id)?.published_at;
      articles.set(id, { url: `https://zhuanlan.zhihu.com/p/${id}`, title: String(item.title || ""), id,
        ...(publishedAt ? { published_at: publishedAt } : {}) });
    } else excluded.set(identity, String(item.type));
    if (includeAnswers && ['article','answer'].includes(item.type)) {
      const id = identity.split(':')[1], previous = materials.get(identity);
      const questionId = item.question?.id;
      if (item.type === 'answer' && (!/^\d+$/u.test(String(questionId)) || (typeof questionId !== 'string' && !Number.isSafeInteger(questionId)))) throw new Error('zhihu_column_answer_identity_invalid');
      const publishedAt = publicationDateFromSeconds(item.created ?? item.created_time) ?? previous?.published_at;
      materials.set(identity, { key: `zhihu:${item.type === 'answer' ? 'answers' : 'articles'}:${id}`,
        url: item.type === 'article' ? `https://zhuanlan.zhihu.com/p/${id}` : `https://www.zhihu.com/question/${questionId}/answer/${id}`,
        title: String(item.type === 'article' ? item.title || '' : item.question.title || ''), author: item.author?.name || previous?.author,
        published_at: publishedAt || null, revision: String(item.updated ?? item.updated_time ?? ''),
        html: item.content_need_truncated ? null : item.content || previous?.html || null });
    }
  };
  let next = nextPage(`/api/columns/${column.id}/items?limit=20&offset=0`, column.id);
  while (next) {
    if (pages >= maxPages) throw new Error("zhihu_column_incomplete_page_limit");
    if (seenPages.has(next)) throw new Error("zhihu_column_incomplete_repeated_page");
    seenPages.add(next);
    const payload = await requestZhihuJson(next, options);
    if (!Array.isArray(payload.data) || typeof payload.paging?.is_end !== "boolean") throw new Error("zhihu_column_paging_invalid");
    if (payload.data.length && payload.data.every(item => listingItems.has(itemIdentity(item)))) throw new Error('zhihu_column_incomplete_repeated_items');
    if (payload.paging.totals != null) {
      const total = Number(payload.paging.totals);
      if (!Number.isSafeInteger(total) || total < 0) throw new Error("zhihu_column_total_invalid");
      if (strictCounts && expectedTotal != null && expectedTotal !== total) throw new Error("zhihu_column_changed_during_listing");
      observedTotals.add(total);
      expectedTotal = total;
    }
    for (const item of payload.data) add(item, true);
    pages += 1;
    await onProgress({ pages, discovered: articles.size, excluded: excluded.size });
    if (payload.paging.is_end) next = null;
    else {
      if (!payload.data.length || !payload.paging.next) throw new Error("zhihu_column_incomplete_next_page_missing");
      next = nextPage(payload.paging.next, column.id);
    }
  }
  if (expectedTotal != null && (listingItems.size !== expectedTotal || observedTotals.size > 1)) {
    if (strictCounts) throw new Error("zhihu_column_incomplete_total_mismatch");
    const warning = { code:'zhihu_column_count_discrepancy', severity:'warning', platform_total:expectedTotal,
      actual_count:listingItems.size, observed_totals:[...observedTotals], inventory_complete:false,
      error:`知乎专栏数量异常：平台 ${expectedTotal}，实际 ${listingItems.size}。已获取内容继续处理。` };
    warnings.push(warning); await onWarning(warning);
  }
  const pinned = await requestZhihuJson(`https://zhuanlan.zhihu.com/api/columns/${column.id}/pinned-items/v2`, options);
  if (!Array.isArray(pinned.data)) throw new Error("zhihu_column_pinned_items_invalid");
  for (const item of pinned.data) { add(item, false); pinnedCount += 1; }
  return {
    source_url: value, column_url: column.url, column_id: column.id, rule_id: column.rule_id,
    complete: warnings.length === 0, pages, listed_items: listingItems.size, expected_total: expectedTotal,
    pinned_items: pinnedCount, excluded_count: excluded.size,
    excluded_types: [...new Set(excluded.values())], articles: [...articles.values()], discovered_at: new Date().toISOString(),
    ...(includeAnswers ? { materials:[...materials.values()] } : {}), ...(warnings.length ? { warnings } : {})
  };
}
