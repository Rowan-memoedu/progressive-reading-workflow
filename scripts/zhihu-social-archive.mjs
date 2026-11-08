import crypto from "node:crypto";
import https from "node:https";

export const ZHIHU_SOCIAL_ARCHIVE_SCHEMA = "local-ir.zhihu-social-archive/v1";
const ACTIVITY_PAGE_SIZE = 20;
const MAX_ACTIVITY_PAGES = 20;
const MAX_SINCE_ACTIVITY_PAGES = 200;

export function canonicalZhihuLikeItem(activity) {
  const verb = String(activity?.verb || "");
  const target = activity?.target || {};
  const targetType = String(target.type || "").toLowerCase();
  const isAnswer = targetType === "answer" || /VOTEUP_ANSWER$/u.test(verb);
  const isArticle = targetType === "article" || /VOTEUP_ARTICLE$/u.test(verb);
  if (!isAnswer && !isArticle) return null;

  const contentId = String(target.id || "").trim();
  if (!/^\d+$/u.test(contentId)) return null;
  if (isAnswer) {
    const questionId = String(target.question?.id || "").trim();
    if (!/^\d+$/u.test(questionId)) return null;
    return {
      activity_id: String(activity.id || ""),
      verb,
      content_type: "answer",
      content_id: contentId,
      source_url: `https://www.zhihu.com/question/${questionId}/answer/${contentId}`,
      title: String(target.question?.title || target.title || "").trim(),
      created_time: Number(activity.created_time || 0)
    };
  }
  return {
    activity_id: String(activity.id || ""),
    verb,
    content_type: "article",
    content_id: contentId,
    source_url: `https://zhuanlan.zhihu.com/p/${contentId}`,
    title: String(target.title || "").trim(),
    created_time: Number(activity.created_time || 0)
  };
}

export async function discoverRecentZhihuLikes({
  profileToken,
  limit,
  cookieByHostname,
  cookieHeaderForUrl,
  fetchImpl = globalThis.fetch,
  requireFullLimit = true,
  retryDelaysMs
}) {
  const normalizedProfile = await resolveProfileToken(profileToken, {
    cookieByHostname,
    cookieHeaderForUrl,
    fetchImpl,
    retryDelaysMs
  });
  const normalizedLimit = Number(limit);
  if (!/^[0-9A-Za-z_-]+$/u.test(normalizedProfile)) throw new Error("zhihu_profile_token_invalid");
  if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 50) {
    throw new Error("zhihu_recent_like_limit_out_of_range");
  }

  let nextUrl = activityUrl(normalizedProfile);
  const candidates = [];
  const seen = new Set();
  let unsupportedVoteActivities = 0;
  let pagesRead = 0;
  while (nextUrl && pagesRead < MAX_ACTIVITY_PAGES && candidates.length <= normalizedLimit) {
    const payload = await requestZhihuJson(nextUrl, {
      cookieByHostname,
      cookieHeaderForUrl,
      fetchImpl,
      retryDelaysMs
    });
    pagesRead += 1;
    for (const activity of payload.data || []) {
      const item = canonicalZhihuLikeItem(activity);
      if (!item) {
        if (/VOTEUP_/u.test(String(activity?.verb || ""))) unsupportedVoteActivities += 1;
        continue;
      }
      if (seen.has(item.source_url)) continue;
      seen.add(item.source_url);
      candidates.push(item);
    }
    nextUrl = safeNextActivityUrl(payload.paging?.is_end ? null : payload.paging?.next);
  }
  if (requireFullLimit && candidates.length < normalizedLimit) {
    throw new Error(`zhihu_recent_likes_incomplete_found_${candidates.length}_unsupported_${unsupportedVoteActivities}_pages_${pagesRead}`);
  }

  const items = candidates.slice(0, normalizedLimit);
  return {
    schema: ZHIHU_SOCIAL_ARCHIVE_SCHEMA,
    profile_token: normalizedProfile,
    requested: normalizedLimit,
    discovered: items.length,
    pages_read: pagesRead,
    urls: items.map((item) => item.source_url),
    items,
    boundary: candidates[normalizedLimit] || null,
    inventory_sha256: sha256Json(items)
  };
}

export async function discoverZhihuLikesSince({
  profileToken,
  sinceEpoch,
  cookieByHostname,
  cookieHeaderForUrl,
  fetchImpl = globalThis.fetch,
  maxPages = MAX_SINCE_ACTIVITY_PAGES,
  retryDelaysMs
}) {
  const normalizedSinceEpoch = Number(sinceEpoch);
  const normalizedMaxPages = Number(maxPages);
  if (!Number.isInteger(normalizedSinceEpoch) || normalizedSinceEpoch < 1) {
    throw new Error("zhihu_since_epoch_invalid");
  }
  if (!Number.isInteger(normalizedMaxPages) || normalizedMaxPages < 1 || normalizedMaxPages > MAX_SINCE_ACTIVITY_PAGES) {
    throw new Error("zhihu_since_max_pages_out_of_range");
  }
  const normalizedProfile = await resolveProfileToken(profileToken, {
    cookieByHostname,
    cookieHeaderForUrl,
    fetchImpl,
    retryDelaysMs
  });

  let nextUrl = activityUrl(normalizedProfile);
  const items = [];
  const seen = new Set();
  let unsupportedVoteActivities = 0;
  let pagesRead = 0;
  let boundary = null;
  let boundaryReason = null;
  while (nextUrl && pagesRead < normalizedMaxPages && !boundary) {
    const payload = await requestZhihuJson(nextUrl, {
      cookieByHostname,
      cookieHeaderForUrl,
      fetchImpl,
      retryDelaysMs
    });
    pagesRead += 1;
    for (const activity of payload.data || []) {
      const createdTime = Number(activity?.created_time || 0);
      if (!Number.isInteger(createdTime) || createdTime < 1) throw new Error("zhihu_activity_created_time_invalid");
      if (createdTime < normalizedSinceEpoch) {
        boundary = canonicalActivityBoundary(activity);
        boundaryReason = "activity_before_since";
        break;
      }
      const item = canonicalZhihuLikeItem(activity);
      if (!item) {
        if (/VOTEUP_/u.test(String(activity?.verb || ""))) unsupportedVoteActivities += 1;
        continue;
      }
      if (seen.has(item.source_url)) continue;
      seen.add(item.source_url);
      items.push(item);
    }
    if (boundary) break;
    nextUrl = safeNextActivityUrl(payload.paging?.is_end ? null : payload.paging?.next);
    if (!nextUrl) boundaryReason = "feed_end";
  }
  if (!boundaryReason) {
    throw new Error(`zhihu_since_inventory_incomplete_boundary_not_reached_pages_${pagesRead}`);
  }

  return {
    schema: ZHIHU_SOCIAL_ARCHIVE_SCHEMA,
    profile_token: normalizedProfile,
    since_epoch: normalizedSinceEpoch,
    since_iso: new Date(normalizedSinceEpoch * 1000).toISOString(),
    discovered: items.length,
    pages_read: pagesRead,
    boundary_reason: boundaryReason,
    boundary,
    unsupported_vote_activities: unsupportedVoteActivities,
    urls: items.map((item) => item.source_url),
    items,
    inventory_sha256: sha256Json(items)
  };
}

export async function unlikeZhihuItems(items, {
  cookieByHostname,
  cookieHeaderForUrl,
  fetchImpl = globalThis.fetch,
  allowAccountMutation = false
} = {}) {
  if (!allowAccountMutation) throw new Error("explicit_account_mutation_flag_required");
  const operations = [];
  for (const item of items || []) {
    const request = cleanupRequest(item);
    const payload = await requestZhihuJson(request.url, {
      cookieByHostname,
      cookieHeaderForUrl,
      fetchImpl,
      method: "POST",
      json: request.json
    });
    const verified = Number(payload?.voting) === 0
      || payload?.is_upped === false
      || payload?.reaction_state === false;
    operations.push({
      source_url: item.source_url,
      content_type: item.content_type,
      content_id: item.content_id,
      endpoint: new URL(request.url).pathname,
      http_status: 200,
      response_verified: verified,
      response_state: {
        voting: Number.isFinite(Number(payload?.voting)) ? Number(payload.voting) : null,
        is_upped: typeof payload?.is_upped === "boolean" ? payload.is_upped : null,
        reaction_state: typeof payload?.reaction_state === "boolean" ? payload.reaction_state : null,
        success: typeof payload?.success === "boolean" ? payload.success : null
      }
    });
    if (!verified) throw new Error(`zhihu_unlike_response_unverified_${item.content_type}_${item.content_id}`);
  }
  return operations;
}

export async function verifyZhihuLikesRemoved({
  profileToken,
  removedItems,
  cookieByHostname,
  cookieHeaderForUrl,
  fetchImpl = globalThis.fetch,
  attempts = 5,
  readbackDelaysMs = [2000, 5000, 10000, 20000]
}) {
  const answerItems = (removedItems || []).filter((item) => item.content_type === "answer");
  const articleItems = (removedItems || []).filter((item) => item.content_type === "article");
  let lastAnswerVerification = null;
  let lastArticleVerification = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastAnswerVerification = await verifyZhihuAnswerStates(answerItems, {
      cookieByHostname,
      cookieHeaderForUrl,
      fetchImpl
    });
    lastArticleVerification = await verifyZhihuArticleStates(articleItems, {
      cookieByHostname,
      cookieHeaderForUrl,
      fetchImpl
    });
    const remaining = [...lastAnswerVerification.remaining, ...lastArticleVerification.remaining];
    if (remaining.length === 0) {
      return {
        status: "verified",
        attempt,
        remaining: [],
        exact_state_sha256: sha256Json([...lastAnswerVerification.states, ...lastArticleVerification.states]),
        answer_readback: "answer_entity_relationship_voting_zero",
        answer_states: lastAnswerVerification.states,
        article_readback: "article_entity_voting_zero",
        article_states: lastArticleVerification.states
      };
    }
    if (attempt < attempts) await delay(Math.max(0, Number(readbackDelaysMs[attempt - 1]) || 0));
  }
  return {
    status: "failed",
    attempt: attempts,
    remaining: [
      ...(lastAnswerVerification?.remaining || []),
      ...(lastArticleVerification?.remaining || [])
    ],
    answer_states: lastAnswerVerification?.states || [],
    article_states: lastArticleVerification?.states || []
  };
}

async function verifyZhihuAnswerStates(items, {
  cookieByHostname,
  cookieHeaderForUrl,
  fetchImpl
}) {
  const states = [];
  for (const item of items) {
    const html = await requestZhihuPageText(item.source_url, {
      cookieByHostname,
      cookieHeaderForUrl,
      fetchImpl
    });
    const voting = extractZhihuAnswerVoting(html, item.content_id);
    states.push({ source_url: item.source_url, content_id: item.content_id, voting });
    if (fetchImpl === globalThis.fetch) await delay(250);
  }
  return {
    states,
    remaining: states.filter((item) => item.voting !== 0).map((item) => item.source_url)
  };
}

async function verifyZhihuArticleStates(items, {
  cookieByHostname,
  cookieHeaderForUrl,
  fetchImpl
}) {
  const states = [];
  for (const item of items) {
    const url = `https://zhuanlan.zhihu.com/p/${item.content_id}`;
    try {
      const html = await requestZhihuPageText(url, {
        cookieByHostname,
        cookieHeaderForUrl,
        fetchImpl
      });
      const voting = extractZhihuArticleVoting(html, item.content_id);
      states.push({ source_url: item.source_url, content_id: item.content_id, voting, state: "readable" });
    } catch (error) {
      if (error?.code !== "ZHIHU_CONTENT_MIGRATED_PROJECT") throw error;
      states.push({
        source_url: item.source_url,
        content_id: item.content_id,
        voting: null,
        state: "migrated_project",
        redirect_path: error.redirectPath
      });
    }
    if (fetchImpl === globalThis.fetch) await delay(250);
  }
  return {
    states,
    remaining: states.filter((item) => item.voting !== 0).map((item) => item.source_url)
  };
}

export function extractZhihuAnswerVoting(html, contentId) {
  const payload = extractZhihuInitialState(html);
  const answer = payload?.initialState?.entities?.answers?.[String(contentId)];
  if (!answer || String(answer.id || "") !== String(contentId) || answer.type !== "answer") {
    throw new Error("zhihu_answer_entity_missing");
  }
  const voting = Number(answer.relationship?.voting);
  if (!Number.isInteger(voting)) throw new Error("zhihu_answer_voting_state_invalid");
  return voting;
}

export function extractZhihuArticleVoting(html, contentId) {
  const payload = extractZhihuInitialState(html);
  const article = payload?.initialState?.entities?.articles?.[String(contentId)];
  if (!article || String(article.id || "") !== String(contentId) || article.type !== "article") {
    throw new Error("zhihu_article_entity_missing");
  }
  const voting = Number(article.voting);
  if (!Number.isInteger(voting)) throw new Error("zhihu_article_voting_state_invalid");
  return voting;
}

function extractZhihuInitialState(html) {
  const match = String(html || "").match(/<script[^>]+id=["']js-initialData["'][^>]*>([\s\S]*?)<\/script>/iu);
  if (!match) throw new Error("zhihu_initial_state_missing");
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new Error("zhihu_initial_state_invalid");
  }
}

export function buildProgressiveReadingHandoffCommand(urls) {
  const normalizedUrls = [...new Set((urls || []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!normalizedUrls.length) throw new Error("handoff_urls_required");
  return `用以下 ${normalizedUrls.length} 个 URL 跑标准导入 Canary：\n${normalizedUrls.join("\n")}`;
}

function cleanupRequest(item) {
  if (item?.content_type === "answer" && /^\d+$/u.test(String(item.content_id || ""))) {
    return {
      url: `https://www.zhihu.com/api/v4/answers/${item.content_id}/voters`,
      json: { type: "neutral" }
    };
  }
  if (item?.content_type === "article" && /^\d+$/u.test(String(item.content_id || ""))) {
    return {
      url: `https://www.zhihu.com/api/v4/articles/${item.content_id}/voters`,
      json: { voting: 0 }
    };
  }
  throw new Error("zhihu_cleanup_item_invalid");
}

export async function requestZhihuJson(url, {
  cookieByHostname,
  cookieHeaderForUrl,
  fetchImpl = fetch,
  method = "GET",
  json = null,
  retryDelaysMs = [1000, 3000, 8000, 20000],
  allowAnonymous = false
}) {
  const parsed = new URL(url);
  const columnRead = parsed.origin === 'https://zhuanlan.zhihu.com' && method === 'GET'
    && /^\/api\/columns\/[0-9A-Za-z_-]+\/(?:items|pinned-items\/v2)$/u.test(parsed.pathname);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
    || (parsed.origin !== 'https://www.zhihu.com' && !columnRead)) {
    throw new Error("zhihu_request_origin_invalid");
  }
  const cookie = typeof cookieHeaderForUrl === "function"
    ? await cookieHeaderForUrl(parsed.href)
    : cookieByHostname?.get?.(parsed.hostname) || cookieByHostname?.get?.("zhihu.com") || "";
  if (!cookie && !allowAnonymous) throw new Error("zhihu_cookie_not_synced");
  if (allowAnonymous && method !== "GET") throw new Error("zhihu_anonymous_read_only");
  const headers = {
    Accept: "application/json, text/plain, */*",
    'User-Agent': columnRead ? 'Mozilla/5.0' : 'ProgressiveReading-LocalFetcher/1.0',
    ...(cookie ? { Cookie: cookie } : {})
  };
  if (/^\/api\/v3\/moments\//u.test(parsed.pathname)) headers["X-API-VERSION"] = "3.0.40";
  const options = { method, headers, redirect: "error" };
  if (json != null) {
    headers["Content-Type"] = "application/json";
    const xsrf = cookieValue(cookie, "_xsrf");
    if (xsrf) headers["x-xsrftoken"] = xsrf;
    options.body = JSON.stringify(json);
  }
  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : [];
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(parsed.href, options);
    const text = await response.text();
    if (response.ok) {
      try {
        return JSON.parse(text || "{}");
      } catch {
        throw new Error("zhihu_json_response_invalid");
      }
    }
    const retryable = method === "GET" && new Set([403, 429]).has(response.status) && attempt < delays.length;
    if (!retryable) throw new Error(`zhihu_http_${response.status}`);
    await delay(Math.max(0, Number(delays[attempt]) || 0));
  }
}

async function requestZhihuPageText(url, {
  cookieByHostname,
  cookieHeaderForUrl,
  fetchImpl,
  retryDelaysMs = [1000, 3000, 8000, 20000]
}) {
  const parsed = new URL(url);
  const validArticle = parsed.hostname === "zhuanlan.zhihu.com" && /^\/p\/\d+$/u.test(parsed.pathname);
  const validAnswer = parsed.hostname === "www.zhihu.com" && /^\/question\/\d+\/answer\/\d+$/u.test(parsed.pathname);
  if (parsed.protocol !== "https:" || (!validArticle && !validAnswer)) {
    throw new Error("zhihu_content_state_origin_invalid");
  }
  const cookie = typeof cookieHeaderForUrl === "function"
    ? await cookieHeaderForUrl(parsed.href)
    : cookieByHostname?.get?.(parsed.hostname) || cookieByHostname?.get?.("zhihu.com") || "";
  if (!cookie) throw new Error("zhihu_cookie_not_synced");
  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : [];
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      const headers = {
        Accept: "text/html,application/xhtml+xml",
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0"
      };
      response = fetchImpl === globalThis.fetch
        ? await requestNativeHttpsText(parsed.href, headers)
        : await fetchImpl(parsed.href, { method: "GET", headers, redirect: "error" });
    } catch (error) {
      if (attempt >= delays.length) throw new Error(`zhihu_content_state_network_${error?.message || "failed"}`);
      await delay(Math.max(0, Number(delays[attempt]) || 0));
      continue;
    }
    const text = typeof response.text === "function" ? await response.text() : response.text;
    if (response.ok) return text;
    if (response.status === 302 && response.location) {
      const redirect = new URL(response.location, parsed.href);
      if (redirect.hostname === "www.zhihu.com" && /^\/project\/detail\/\d+$/u.test(redirect.pathname)) {
        const error = new Error("zhihu_content_migrated_project");
        error.code = "ZHIHU_CONTENT_MIGRATED_PROJECT";
        error.redirectPath = redirect.pathname;
        throw error;
      }
    }
    const retryable = new Set([403, 429]).has(response.status) && attempt < delays.length;
    if (!retryable) throw new Error(`zhihu_content_state_http_${response.status}`);
    await delay(Math.max(0, Number(delays[attempt]) || 0));
  }
}

function requestNativeHttpsText(url, headers) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "GET",
      headers: { ...headers, Connection: "close" },
      timeout: 30_000,
      agent: false
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {
          request.destroy(new Error("zhihu_content_state_response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        ok: Number(response.statusCode || 0) >= 200 && Number(response.statusCode || 0) < 300,
        status: Number(response.statusCode || 0),
        location: response.headers.location || null,
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("timeout", () => request.destroy(new Error("zhihu_content_state_timeout")));
    request.on("error", reject);
    request.end();
  });
}

async function resolveProfileToken(profileToken, requestOptions) {
  let normalizedProfile = String(profileToken || "").trim();
  if (!normalizedProfile) {
    const me = await requestZhihuJson("https://www.zhihu.com/api/v4/me", requestOptions);
    normalizedProfile = String(me?.url_token || "").trim();
  }
  if (!/^[0-9A-Za-z_-]+$/u.test(normalizedProfile)) throw new Error("zhihu_profile_token_invalid");
  return normalizedProfile;
}

function canonicalActivityBoundary(activity) {
  const item = canonicalZhihuLikeItem(activity);
  return {
    activity_id: String(activity?.id || ""),
    verb: String(activity?.verb || ""),
    created_time: Number(activity?.created_time || 0),
    target_type: String(activity?.target?.type || ""),
    source_url: item?.source_url || null
  };
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function activityUrl(profileToken) {
  const url = new URL(`https://www.zhihu.com/api/v3/moments/${encodeURIComponent(profileToken)}/activities`);
  url.searchParams.set("limit", String(ACTIVITY_PAGE_SIZE));
  url.searchParams.set("ws_qiangzhisafe", "0");
  return url.href;
}

function safeNextActivityUrl(value) {
  if (!value) return null;
  const parsed = new URL(String(value));
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.zhihu.com"
    || !/^\/api\/v3\/moments\/[^/]+\/activities$/u.test(parsed.pathname)) {
    throw new Error("zhihu_activity_pagination_origin_invalid");
  }
  return parsed.href;
}

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
