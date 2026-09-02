import assert from "node:assert/strict";
import {
  buildProgressiveReadingHandoffCommand,
  canonicalZhihuLikeItem,
  discoverRecentZhihuLikes,
  discoverZhihuLikesSince,
  extractZhihuAnswerVoting,
  extractZhihuArticleVoting,
  unlikeZhihuItems,
  verifyZhihuLikesRemoved
} from "./zhihu-social-archive.mjs";

const activities = Array.from({ length: 30 }, (_unused, index) => index % 2 === 0
  ? answerActivity(index + 1)
  : articleActivity(index + 1));
const removed = new Set();
const requests = [];
const cookieByHostname = new Map([
  ["www.zhihu.com", "_xsrf=fixture-xsrf; z_c0=private-fixture"],
  ["zhuanlan.zhihu.com", "_xsrf=fixture-xsrf; z_c0=private-fixture"]
]);
const cookieHeaderForUrl = (url) => new Set(["www.zhihu.com", "zhuanlan.zhihu.com"]).has(new URL(url).hostname)
  ? "_xsrf=fixture-xsrf; z_c0=private-fixture"
  : "";
const fetchImpl = async (url, options = {}) => {
  requests.push({ url: String(url), method: options.method || "GET", headers: { ...options.headers }, body: options.body || null });
  const parsed = new URL(String(url));
  if (parsed.hostname === "zhuanlan.zhihu.com") {
    const articleId = parsed.pathname.match(/^\/p\/(\d+)$/u)?.[1];
    assert.ok(articleId);
    const voting = removed.has(`article:${articleId}`) ? 0 : 1;
    return new Response(articleHtml(articleId, voting), { status: 200 });
  }
  const answerPage = parsed.pathname.match(/^\/question\/\d+\/answer\/(\d+)$/u);
  if (answerPage) {
    const answerId = answerPage[1];
    const voting = removed.has(`answer:${answerId}`) ? 0 : 1;
    return new Response(answerHtml(answerId, voting), { status: 200 });
  }
  if (options.method === "POST") {
    const match = parsed.pathname.match(/^\/api\/v4\/(answers|articles)\/(\d+)\/voters$/u);
    assert.ok(match);
    assert.equal(options.headers["x-xsrftoken"], "fixture-xsrf");
    const type = match[1] === "answers" ? "answer" : "article";
    removed.add(`${type}:${match[2]}`);
    return new Response(JSON.stringify({ success: true, voting: 0, is_upped: false }), { status: 200 });
  }
  if (parsed.pathname === "/api/v4/me") {
    return new Response(JSON.stringify({ url_token: "fixture-profile" }), { status: 200 });
  }
  assert.match(parsed.pathname, /^\/api\/v3\/moments\/fixture-profile\/activities$/u);
  assert.equal(options.headers["X-API-VERSION"], "3.0.40");
  const data = activities.filter((item) => !removed.has(`${item.target.type}:${item.target.id}`));
  return new Response(JSON.stringify({ data, paging: { is_end: true, next: null } }), { status: 200 });
};

assert.equal(canonicalZhihuLikeItem({ verb: "MEMBER_FOLLOW_QUESTION", target: { type: "question", id: 1 } }), null);
assert.equal(extractZhihuAnswerVoting(answerHtml("2001", 1), "2001"), 1);
assert.equal(extractZhihuArticleVoting(articleHtml("3001", 1), "3001"), 1);
const inventory = await discoverRecentZhihuLikes({
  profileToken: "fixture-profile",
  limit: 10,
  cookieByHostname,
  fetchImpl
});
assert.equal(inventory.discovered, 10);
assert.equal(inventory.urls.length, 10);
assert.equal(inventory.boundary.source_url, "https://www.zhihu.com/question/1011/answer/2011");
assert.deepEqual(new Set(inventory.items.map((item) => item.content_type)), new Set(["answer", "article"]));

await assert.rejects(() => unlikeZhihuItems(inventory.items, { cookieByHostname, fetchImpl }), /explicit_account_mutation/);
await assert.rejects(() => unlikeZhihuItems([inventory.items[0]], {
  cookieByHostname,
  allowAccountMutation: true,
  fetchImpl: async () => new Response(JSON.stringify({ success: true }), { status: 200 })
}), /response_unverified/);
const operations = await unlikeZhihuItems(inventory.items, {
  cookieByHostname,
  fetchImpl,
  allowAccountMutation: true
});
assert.equal(operations.length, 10);
assert.ok(operations.every((item) => item.response_verified));

const verification = await verifyZhihuLikesRemoved({
  profileToken: "fixture-profile",
  removedItems: inventory.items,
  cookieByHostname,
  fetchImpl
});
assert.equal(verification.status, "verified");
assert.equal(verification.remaining.length, 0);
let staleReadbacks = 0;
const delayedVerification = await verifyZhihuLikesRemoved({
  profileToken: "fixture-profile",
  removedItems: inventory.items,
  cookieHeaderForUrl,
  readbackDelaysMs: [0],
  fetchImpl: async (url) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "zhuanlan.zhihu.com") {
      const articleId = parsed.pathname.match(/^\/p\/(\d+)$/u)?.[1];
      return new Response(articleHtml(articleId, 0), { status: 200 });
    }
    const answerPage = parsed.pathname.match(/^\/question\/\d+\/answer\/(\d+)$/u);
    if (answerPage) return new Response(answerHtml(answerPage[1], 0), { status: 200 });
    staleReadbacks += 1;
    const data = staleReadbacks === 1
      ? activities
      : activities.filter((item) => !removed.has(`${item.target.type}:${item.target.id}`));
    return new Response(JSON.stringify({ data, paging: { is_end: true, next: null } }), { status: 200 });
  }
});
assert.equal(delayedVerification.status, "verified");
assert.equal(delayedVerification.attempt, 1);
const exactActiveVerification = await verifyZhihuLikesRemoved({
  profileToken: "fixture-profile",
  removedItems: [inventory.items.find((item) => item.content_type === "answer")],
  cookieHeaderForUrl,
  attempts: 1,
  fetchImpl: async (url) => {
    const answerId = new URL(String(url)).pathname.match(/^\/question\/\d+\/answer\/(\d+)$/u)?.[1];
    return new Response(answerHtml(answerId, 1), { status: 200 });
  }
});
assert.equal(exactActiveVerification.status, "failed");
assert.equal(exactActiveVerification.remaining.length, 1);
assert.equal(requests.filter((item) => item.method === "POST").length, 10);
const snapshotInventory = await discoverRecentZhihuLikes({
  limit: 10,
  cookieHeaderForUrl,
  fetchImpl
});
assert.equal(snapshotInventory.discovered, 10);
const sinceInventory = await discoverZhihuLikesSince({
  profileToken: "fixture-profile",
  sinceEpoch: 2_000_000_000 - 20,
  cookieHeaderForUrl,
  fetchImpl: async () => new Response(JSON.stringify({ data: activities, paging: { is_end: true, next: null } }), { status: 200 })
});
assert.equal(sinceInventory.discovered, 20);
assert.equal(sinceInventory.boundary_reason, "activity_before_since");
assert.equal(sinceInventory.boundary.created_time, 2_000_000_000 - 21);
assert.equal(sinceInventory.urls.length, 20);

let retryRequests = 0;
const retryInventory = await discoverZhihuLikesSince({
  profileToken: "fixture-profile",
  sinceEpoch: 1,
  cookieHeaderForUrl,
  retryDelaysMs: [0],
  fetchImpl: async () => {
    retryRequests += 1;
    if (retryRequests === 1) return new Response("{}", { status: 403 });
    return new Response(JSON.stringify({ data: [answerActivity(1)], paging: { is_end: true, next: null } }), { status: 200 });
  }
});
assert.equal(retryRequests, 2);
assert.equal(retryInventory.discovered, 1);
assert.equal(retryInventory.boundary_reason, "feed_end");

await assert.rejects(() => discoverZhihuLikesSince({
  profileToken: "fixture-profile",
  sinceEpoch: 1,
  maxPages: 1,
  cookieHeaderForUrl,
  fetchImpl: async () => new Response(JSON.stringify({
    data: [answerActivity(1)],
    paging: { is_end: false, next: "https://www.zhihu.com/api/v3/moments/fixture-profile/activities?limit=20&after_id=1" }
  }), { status: 200 })
}), /boundary_not_reached/);
assert.equal(
  buildProgressiveReadingHandoffCommand([inventory.urls[0], inventory.urls[1], inventory.urls[0]]),
  `用以下 2 个 URL 跑标准导入 Canary：\n${inventory.urls[0]}\n${inventory.urls[1]}`
);

console.log(JSON.stringify({ result: "passed", tests: 33 }, null, 2));

function answerActivity(number) {
  return {
    id: `activity-answer-${number}`,
    verb: "MEMBER_VOTEUP_ANSWER",
    created_time: 2_000_000_000 - number,
    target: {
      type: "answer",
      id: 2000 + number,
      question: { id: 1000 + number, title: `Question ${number}` }
    }
  };
}

function articleActivity(number) {
  return {
    id: `activity-article-${number}`,
    verb: "MEMBER_VOTEUP_ARTICLE",
    created_time: 2_000_000_000 - number,
    target: { type: "article", id: 3000 + number, title: `Article ${number}` }
  };
}

function articleHtml(id, voting) {
  const payload = {
    initialState: {
      entities: {
        articles: {
          [id]: { id, type: "article", voting }
        }
      }
    }
  };
  return `<!doctype html><script id="js-initialData" type="text/json">${JSON.stringify(payload)}</script>`;
}

function answerHtml(id, voting) {
  const payload = {
    initialState: {
      entities: {
        answers: {
          [id]: { id, type: "answer", relationship: { voting } }
        }
      }
    }
  };
  return `<!doctype html><script id="js-initialData" type="text/json">${JSON.stringify(payload)}</script>`;
}
