import assert from "node:assert/strict";
import { fetchUrlWithoutBrowser } from "./url-background-fetch.mjs";

const requestedUrl = "https://zhuanlan.zhihu.com/p/2057483183617267370";
const projectUrl = "https://www.zhihu.com/project/detail/270246?zh_hide_nav_bar=true";
const apiUrl = "https://www.zhihu.com/api/v4/creation_project/projects/270246/detail";
const calls = [];
const fetchImpl = async (url, options) => {
  calls.push({ url: String(url), cookie: options.headers.Cookie || null });
  if (String(url) === requestedUrl) {
    return new Response(null, { status: 302, headers: { location: projectUrl } });
  }
  if (String(url) === projectUrl) {
    return new Response('<!doctype html><html><head><title>AI Works - 知乎</title></head><body><div id="root"></div><script src="app.js"></script><script>boot()</script></body></html>', {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
  if (String(url) === apiUrl) {
    return Response.json({
      status: 0,
      msg: "成功",
      data: {
        content: {
          title: "测试项目",
          description: "项目简介",
          body: "<h2>正文</h2><p>可读内容</p>",
          work_url: "https://example.test/work",
          github_url: "https://github.com/example/work"
        },
        project_info: { id: 270246, name: "测试项目" }
      }
    });
  }
  throw new Error(`unexpected_fetch_${url}`);
};

const result = await fetchUrlWithoutBrowser(requestedUrl, {
  fetchImpl,
  cookieHeaderForUrl: () => "fixture_session=private-value"
});
assert.equal(result.finalUrl, projectUrl);
assert.equal(result.title, "测试项目");
assert.match(result.visibleText, /测试项目.*项目简介.*正文.*可读内容/u);
assert.equal(result.sourceMetadata.capture_fallback, "zhihu_creation_project_api");
assert.equal(result.sourceMetadata.project_id, "270246");
assert.equal(result.sourceMetadata.project_api_response_status, 200);
assert.equal(result.fetchReceipt.authenticated_fetch, true);
assert.deepEqual(calls.map((item) => item.url), [requestedUrl, projectUrl, apiUrl]);
assert.ok(calls.every((item) => item.cookie === "fixture_session=private-value"));
assert.doesNotMatch(JSON.stringify(result), /private-value/u);

console.log(JSON.stringify({
  status: "passed",
  checks: ["zhihu_project_redirect", "project_api_fallback", "readable_html", "cookie_not_persisted"]
}, null, 2));
