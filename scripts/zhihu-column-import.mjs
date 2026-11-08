import { zhihuColumnIdentity } from "./import-rule-catalog.mjs";
import { requestZhihuJson } from "./zhihu-social-archive.mjs";
import { publicationDateFromSeconds } from "../subscription-workflow/publication-time.mjs";

function nextPage(value, id) {
  const url = new URL(value, "https://www.zhihu.com");
  if (url.origin !== "https://www.zhihu.com" || url.username || url.password || url.pathname !== `/api/v4/columns/${id}/items`) {
    throw new Error("zhihu_column_pagination_origin_invalid");
  }
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

export async function discoverZhihuColumn(value, { cookieHeaderForUrl, fetchImpl = fetch, onProgress = async () => {}, maxPages = 1000 } = {}) {
  const column = zhihuColumnIdentity(value);
  if (!column) throw new Error("zhihu_column_url_invalid");
  const options = { cookieHeaderForUrl, retryDelaysMs: [],
    fetchImpl: (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(30000) }) };
  const articles = new Map();
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
  };
  let next = nextPage(`/api/v4/columns/${column.id}/items?limit=20&offset=0`, column.id);
  while (next) {
    if (pages >= maxPages) throw new Error("zhihu_column_incomplete_page_limit");
    if (seenPages.has(next)) throw new Error("zhihu_column_incomplete_repeated_page");
    seenPages.add(next);
    const payload = await requestZhihuJson(next, options);
    if (!Array.isArray(payload.data) || typeof payload.paging?.is_end !== "boolean") throw new Error("zhihu_column_paging_invalid");
    if (payload.paging.totals != null) {
      const total = Number(payload.paging.totals);
      if (!Number.isSafeInteger(total) || total < 0) throw new Error("zhihu_column_total_invalid");
      if (expectedTotal != null && expectedTotal !== total) throw new Error("zhihu_column_changed_during_listing");
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
  if (expectedTotal != null && listingItems.size !== expectedTotal) throw new Error("zhihu_column_incomplete_total_mismatch");
  const pinned = await requestZhihuJson(`https://www.zhihu.com/api/v4/columns/${column.id}/pinned-items/v2`, options);
  if (!Array.isArray(pinned.data)) throw new Error("zhihu_column_pinned_items_invalid");
  for (const item of pinned.data) { add(item, false); pinnedCount += 1; }
  return {
    source_url: value, column_url: column.url, column_id: column.id, rule_id: column.rule_id,
    complete: true, pages, listed_items: listingItems.size, expected_total: expectedTotal,
    pinned_items: pinnedCount, excluded_count: excluded.size,
    excluded_types: [...new Set(excluded.values())], articles: [...articles.values()], discovered_at: new Date().toISOString()
  };
}
