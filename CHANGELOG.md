# Changelog

## 2026-07-08 - Browser Highlight v0.2.0

- Changed browser highlight capture from excerpt-log mode to full-page Markdown mode.
- First capture for a URL now creates `标题--网页全文高亮--hash.md` under `阅读区/浏览器高亮`; later captures for the same URL update that same file.
- Added Readability + Turndown conversion inside the local app using the browser-provided DOM HTML, with page-text fallback when article extraction fails.
- Added inline Obsidian legacy highlight insertion with normalized whitespace matching and `## 未定位高亮` fallback when the selected text cannot be located after conversion.
- Raised the extension version to `0.2.0` and updated `browser-highlight:check` to verify full-page conversion, same-URL updates, inline highlighting, and unlocated-highlight fallback.

## 2026-07-08 - Browser Highlight v0.1.2

- Added visible popup startup status, version display, and `运行诊断` to expose service worker, local app, tab, and injection failures instead of appearing unresponsive.
- Reworked popup and background Chrome extension calls through callback wrappers for better Edge compatibility.
- Added `打开测试页` and local `/browser-highlight-test` for controlled end-to-end extension checks.
- Strengthened `browser-highlight:check` to verify diagnostics, callback wrappers, test page routing, and v0.1.2 version consistency.
- Documented the need to click `重新加载` for the unpacked extension after file changes.

## 2026-07-08 - Browser Highlight v0.1.1

- Fixed Chromium Manifest host permission patterns by replacing invalid localhost/IP port wildcards with valid match patterns.
- Added the `scripting` permission and popup-driven content script injection, so ordinary pages opened before extension load no longer need a refresh.
- Added popup health probing across ports `37829-37849`; the detected port is stored automatically.
- Strengthened `browser-highlight:check` to catch invalid Manifest patterns, missing injection hooks, missing port probing, and duplicate content-script listener risk.
- Updated browser highlight docs with load-unpacked troubleshooting, unsupported page boundaries, and retry-queue behavior.

## 2026-07-08 - Browser Highlight v0.1

- Added a reuse-first browser highlight input path.
- Documented the preferred Obsidian Web Clipper route for saving browser highlights as durable Markdown.
- Added a lightweight unpacked Chromium extension under `browser-highlight-extension/` for the local fallback route.
- Added `GET /api/highlights/health` and `POST /api/highlights/capture` to the local import app.
- Browser captures are appended under `阅读区/浏览器高亮` using Obsidian legacy highlight syntax `==...==`, so Local IR can upgrade them later.
- Added right-click browser actions for importing links or the current page through the existing `/api/import` route.
- Added `browser-highlight:sync-lib` and `browser-highlight:check` package scripts.
