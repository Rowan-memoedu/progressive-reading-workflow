# Changelog

## 2026-11-04 — 浏览器保存统一标准流程 / 预处理 1.12.4

- 直接保存、自动提交、完成阅读与导入本地复用标准预处理、质量检查、批注锚定和写入实现；通过处理配置控制导读，直接保存不调用模型。
- 公式文本模式的字面下划线统一转义，修复 MathJax 4 的 `_ allowed only in math mode` 错误。标准接口直接返回的阅读 Markdown 与文件发布均兼容，原始来源和审计保留原样。
- 增加独立公式样本和真实 HTTP 回归，覆盖无导读保存、同步/异步导读导入、待归档路径、来源审计、内容哈希及不重抓快照。

## 2026-08-23 — 共享 URL 导入衔接层 v1

- 浏览器 URL 入口与 Obsidian Local IR 统一提交到同一个 broker，由服务端唯一 `background_fetch` worker 静默抓取并调用标准 Markdown 前置处理接口。
- URL 认证主路改为只读加载 `Chrome Cookie Sync` 的 `local.chrome-cookie-snapshot` v1；按 domain/hostOnly/path/secure/过期规则匹配，并在每次重定向后按新 URL 重算。
- 旧浏览器抓取 worker、内容标签页和运行时 Cookie 替换不再进入默认主路；合成 E2E 覆盖双入口、无标签页、无凭据持久化与统一回执。

## 2026-08-22 — RemNote 正式归档 v0.3.0

- 问答卡改为一次提交 content-only RemNote 原生 `>>>` 多行 Markdown tree，并以 `cardDirection=forward` 和答案行回读验收。
- itemKey、hash、package ID、来源格式、本地路径和 AI/重试/归档状态全部移出 RemNote 人类可见标题与正文，仅保留在本地 state/receipt。
- 无远端技术标记的崩溃恢复改为精确父文档、人类标题、可见正文语义和卡片方向对账；17/17 离线回归与 3/3 新隔离 Canary 通过。

## 2026-08-22 — RemNote 正式归档 v0.2.0

- 复用唯一入口 `scripts/import-remnote-queue.mjs`，发布 native-v2 package/receipt schema、来源描述和完整 disposition 合同；文章随想进入 `文章随想`，未覆盖派生项 fail closed。
- 增加稳定 itemKey 对账、RemNote 卡片标题规范化、QA card direction 回读、部分失败重试和 archived 状态自愈。
- 15/15 离线回归通过；隔离 RemNote 对 5 种来源格式、6 种批注类型和 6 种卡片/路由场景完成 17/17 写入、回读、receipt 与本地归档 Canary。
- release 状态为 `canary_passed_producer_blocked`：Local IR 0.7.19 尚未实现 native-v2 和“receipt 后才 archived”的生产者合同。

## 2026-08-21 — 标准预处理 1.10.5

- 新增最终可见正文锚点剪枝：先为全部正文块生成稳定 block id，再只在 `reading.md` 保留被阅读前置卡实际引用的锚点。
- 未引用锚点只从最终阅读 Markdown 删除；`artifacts.body_blocks`、来源映射、哈希和审计回执保持完整，并新增 `visible_body_anchor_pruning` 校验。

## 2026-08-21 — 标准预处理 1.9.0

- 阅读前置卡的价值判断和信息密度判断由三档扩展为“极低 / 低 / 中 / 高 / 极高”五档。
- 提示词要求依据正文证据选档，并禁止把“中”作为不确定时的默认答案；其余阅读深度、清洗、洞察与渲染合同不变。

## 2026-08-21 — Browser Highlight v0.5.7 / browser import broker

- 新增持久化浏览器导入请求接口；Obsidian 只负责提交 URL 和查询回执，浏览器扩展负责真实渲染页面采集，本地服务统一负责标准预处理与落盘。
- 浏览器采集执行器通过长轮询与定时唤醒领取任务，最多三路并发，并对任务提供领取租约、失败回执和过期恢复。
- 队列状态保存在 `.local-ir/browser-import-broker/`，不进入阅读目录。

## 2026-08-21 — Browser Highlight v0.5.6

- 右键链接导入不再依赖容易被站点反爬拦截的服务端直抓；改为非激活临时页加载目标链接，并复用已验证的页面快照标准导入流程。
- 导入完成或失败后自动关闭扩展创建的临时页，同时保留原页面进度、结果提示和扩展角标反馈。

## 2026-08-17 - Obsidian 批量 URL 标准导入

- 新增 `/api/highlights/import-local-urls` 薄接口，支持从混合文本或 URL 数组中识别、校验和去重多个 `http/https` 链接。
- URL 适配层只负责抓取网页和最多三路并行编排；最终逐条复用浏览器“导入本地”的标准预处理与 Local IR 落盘函数。
- 隔离回归覆盖中文/英文括号、Markdown 链接、追踪参数去重、并行回执、无效协议拒绝和审计 JSON 不进入阅读区。

## 2026-08-16 - Browser Highlight v0.5.4

- 在“初始化加工”旁新增“导入本地”：一次点击完成页面初始化、标准 Markdown 预处理与阅读区保存。
- 新入口调用正式 `preprocessBrowserCapture` 接口；只有 ready 合同完整通过时才向 `阅读区/浏览器高亮/` 写入最终 Markdown。
- 预处理请求、结果、运行清单和原始 `reading.md` 存放在 `.local-ir/browser-standard-preprocess/`，阅读区不写入 JSON。
- 标准导入草稿记录提交模式，失败重试和浏览器恢复不会静默退化为普通本地转换。
- 隔离端到端测试使用合成 producer，验证标准接口、目标目录、审计产物、Local IR sidecar 和阅读区无 JSON。

## 2026-08-16 - Browser Highlight v0.5.3

- `完成阅读` 与普通保存共用同一 `浏览器高亮/` 子目录、文件命名、Markdown 转换、`import_method`、虚拟高亮、评论、问答卡和随想写入合同；只把根目录切换到 `待归档原文/` 并写入 `done` 状态。
- 已完成草稿重新导入时保留 `completed` 目的地，不再错误写回阅读区。
- 服务启动时通用迁移旧版直接写在 `待归档原文/` 的浏览器完成产物，同时更新 sidecar 路径并保留全部批注。
- 隔离端到端测试新增“完成阅读不得分叉保存合同”的字段级回归检查。

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
