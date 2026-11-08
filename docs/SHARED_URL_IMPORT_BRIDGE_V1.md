# 共享 URL 导入衔接层 v1

2026-09-14 增加独立 Chrome 扩展持续推送、专用本地凭据存储和消费者热更新，详见 [登录态同步](CHROME_LOGIN_SYNC.md)。手动版本化快照仍兼容；不再要求每次更新都重启服务。

## 边界

本文件描述浏览器插件、Obsidian Local IR 和 AI 自动化的 **URL 提交入口**：只提交 URL 与入口目录语义，调用本机环回服务的 `POST /api/browser-import/requests`，由同一个 `BrowserImportBroker` 和服务端 `background_fetch` worker 执行。该入口不读取 Cookie、不抓取正文、不 claim broker task，也不创建内容标签页。

页面内的 **“导入本地”按钮是已有的页面快照入口**：`content.js` 的 `sourceSnapshot()` 读取 Chrome 已加载的页面 HTML/正文，经 `draft-import-local` → `submitDraft()` → `POST /api/highlights/import-local` 调用同一标准预处理与发布实现。它不需要服务端再次抓取源 URL。不能把 URL 入口的约束推广为所有浏览器按钮的行为；Cookie 同步也不保证所有浏览器可访问页面都可由 Node fetch 重现。2026-09-18 SuperMemo Guru 的当前验证见 [章节采集核验](D:/Artifacts/ProgressiveReading/chapter-collection-20260918/采集核验.md)。

共享 worker 依次执行：

1. 从显式环境变量、固定持续同步文件或旧路径指针读取 `local.chrome-cookie-snapshot`、`schemaVersion: 1`，自动检查变更；路径丢失不会阻断服务启动。
2. 每个请求及每次重定向都根据当前 URL 重新匹配 `domain + hostOnly + path + secure + expirationDate`；分区 Cookie 在 v1 消费端跳过并计数。
3. 使用 Node 后台 `fetch` 静默抓取，不读取 Chrome 当前状态，不打开可见或隐藏标签页。
4. 默认把原始 HTML/文本交给 `standard-preprocessing/integrations/browser-capture.mjs` 的 `preprocessBrowserCapture()`。2026-09-15 待测的显式 `processing_mode: original_text` 分支复用正文转换和发布函数，跳过 LLM；RSS 入口必须先从健康接口确认后端支持该模式。
5. 通过 `GET /api/browser-import/requests/:requestId` 返回统一回执。

## 请求

```json
{
  "urls": ["https://example.test/article"],
  "source": "browser_extension_entry | obsidian_local_ir | ai_automation",
  "entry_route": "browser_extension | obsidian | ai",
  "destination_folder": "AI 入口必填的阅读区相对路径",
  "client_request_id": "入口生成的幂等 ID",
  "user_instruction": "可选"
}
```

服务统一把任务 transport 固定为 `background_fetch`；客户端传入的其它 transport 不会改变执行器。

目录路由由 `config/import-destination-routes.json` 管理：浏览器插件固定进入“浏览器高亮”，Obsidian 按 URL 域名分类，AI 入口显式注入 `destination_folder`。完整约束见 `docs/IMPORT_DESTINATION_ROUTING.md`。

## 回执

终态条目为 `imported`、`idempotent_replay`、`failed`、`requires_browser_auth` 或 `requires_js_render`。成功条目包含最终 URL、重定向链、标准 Markdown artifacts、source metadata 与 receipt；receipt 明确返回：

- `browser_tab_created: false`
- `cookie_policy: versioned_snapshot_cookie_matching_no_store`
- `processing_mode: standard_preprocess`；显式原文模式为 `original_text`，同时返回 `llm_used:false`。命中既有内容时返回其实际处理模式及 `existing_article_preserved:true`，不为改变模式重复建档。

broker、Markdown、审计、健康接口和普通日志都不得持久化或输出 Cookie 名称、值、域名/路径列表；健康接口只返回计数、状态和不可逆指纹。

## 本机快照指针

前台开发可直接设置 `PROGRESSIVE_READING_COOKIE_SNAPSHOT_PATH`。`scripts/start-local-ir-browser-highlight-app.cmd` 在变量未设置时只读取被 `.gitignore` 排除的 `.local-ir/cookie-snapshot.path` 第一行。指针文件只保存绝对路径；快照本身不得复制到项目、测试、日志或 Git。

旧运行时 Cookie POST 和精确 hostname 环境变量实现保留作取证/兼容代码，但默认 URL 导入主路不再使用；运行时 Cookie Jar 替换默认拒绝。

## 安全验证

```powershell
npm run shared-url-snapshot:e2e
npm run cookie-snapshot:check -- "C:\absolute\path\to\chrome-cookie-snapshot-v1-....json"
```

第一条只使用合成快照和本地合成 HTTP 服务。第二条只做本地解析与匹配统计，不发网络请求，不显示快照路径或任何 Cookie 明细。
