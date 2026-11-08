# 共享 URL 导入请求接口（三端入口）

更新：2026-09-14。现有文件名和 HTTP 路径保留兼容性；网页导入页首版位于 `/import`，活动服务、真实 Chrome 界面及知乎专栏 7/7 篇落盘均已验收，证据见 [网页导入页](../WEB_IMPORT_PAGE.md)。

## 目标

URL 输入、来源采集、标准预处理和阅读区写入是四个独立职责。网页、Obsidian 与浏览器扩展共用一个后端，不复制预处理规则，也不直接决定最终文件格式。

## 模块边界

- Obsidian Local IR：识别与去重 URL，创建导入请求，查询状态并展示逐条结果。
- 网页导入页：对齐 Obsidian 的混合文字/Markdown 链接识别、规范化去重、批量提交、逐条结果与失败重试；不承担读取或加工文章的功能。
- 本地服务：持久化请求和任务，由后台 URL 执行器抓取内容，调用唯一的标准预处理与落盘实现，并保存逐条回执。
- 浏览器导入扩展：URL 入口提交 URL，不领取任务、不创建抓取标签页；页面内“导入本地”及复用该动作的入口提交已加载页面快照到 `/api/highlights/import-local`，不经过 URL 后台重抓。两者共用标准预处理与发布实现。登录态由独立 Chrome Cookie 同步扩展在用户启用后持续推送；保存、恢复与有效性边界见 [登录态同步](../CHROME_LOGIN_SYNC.md)。
- `pr-preprocess`：只接收正文与来源元数据，执行标准 Markdown 合同；不抓网页、不控制浏览器。

## HTTP 接口

- `POST /api/browser-import/requests`：提交 `urls` 或含链接的 `text`，返回 HTTP 202 和 `request_id`。可携带 `source`、`client_request_id`、`user_instruction`、`entry_route` 和 `destination_folder`；字段含义与路由以现有后端实现为准，当前单请求最多 50 个 URL。
- 2026-09-15 待测扩展：可显式传入 `processing_mode: "original_text"`，仅提取正文并转换 Markdown，不调用 LLM；省略时仍为 `standard_preprocess`。模式由 broker 持久保存，原文回执须含 `llm_used:false`。两种模式共用去重和发布器，既有文章不因模式变化而重写。RSS 三类路由与当前暂停状态见 [RSS 自动导入](../RSS_AUTO_IMPORT.md)。
- `GET /api/browser-import/requests/:requestId`：返回请求状态、数量和逐条回执。
- `GET /api/browser-import/rules`：返回活动规则清单。知乎专栏默认完整枚举文章并分批导入；行为与验证见 [导入规则](../IMPORT_RULES.md)。
- `GET /api/browser-import/tasks/claim`：兼容端点，固定返回扩展执行器已退役。
- `POST /api/browser-import/tasks/:taskId/complete`：内部任务完成回执。
- `POST /api/highlights/import-local`：页面快照进入统一标准预处理与阅读区写入。扩展传 `async: true`、稳定 `client_request_id` 和 `draft`，立即返回 HTTP 202 与 `request_id`；后续使用同一 `GET /api/browser-import/requests/:requestId` 查询。旧同步调用继续兼容。
- `POST /api/highlights/commit` 与 `/api/highlights/complete`：复用相同的 `preprocessBrowserCapture`、标准渲染、质量检查和写入实现；保存配置为 `spoken_to_written:false`、`structure_body:false`、`translate:false`、`include_reading_guide:false`，保留正文且不调用模型。`import-local` 的同步和异步入口均显式携带 `include_reading_guide:true`。完成阅读只改变目标为待归档区和文档状态，不另设正文转换器。

旧 `/api/highlights/import-local-urls` 保留为兼容接口；Obsidian、浏览器 URL 批量提交和社交归档统一提交 `/api/browser-import/requests`。右键“导入当前页到渐进阅读”复用页面按钮的快照流程，调用 `/api/highlights/import-local`。两类输入进入同一个持久 broker：`page_snapshot` 读取已保存快照，`url_fetch` 后台抓取 URL，不重抓页面快照。

现有根网页的 `/api/import` 是旧作业入口，不是新增薄前端应复制的执行链。新页面使用自己的来源标识，并复用 Obsidian 的目录路由策略（现有 `entry_route: "obsidian"`），不伪装为浏览器扩展，也不由前端自行创建输出路径。既有浏览器固定目录与 AI 显式目标目录规则保持不变；全局来源 URL 去重仍由后端负责。

初始优先级所需的评估由标准预处理产生，经标准 Markdown 与元数据交给加工阶段初始化；前端不自行重算优先级，也不借重试覆盖人工编辑。接口详情见 [共享衔接层](../SHARED_URL_IMPORT_BRIDGE_V1.md)、[目录路由](../IMPORT_DESTINATION_ROUTING.md) 和 [预处理接口](../STANDARD_MARKDOWN_PREPROCESSING_INTERFACE.md)。

## 状态与恢复

页面快照保存于 `.local-ir/browser-import-broker/snapshots/`。扩展先在 `chrome.storage.local` 保存客户端键，获得服务端编号后只查询；刷新页面或 service worker 重建后可恢复任务。`results[].stage` 报告提取、分类、翻译、导读阶段，失败保留具体错误，只有正式写入后才锁定草稿。重新导入生成新任务，继续复用预处理阶段缓存；不得因草稿已经锁定而跳过发送。状态文字位于折叠加工控件之外。

要求的译文或导读未生成时返回明确失败（同步页面接口为 HTTP 422），不发布原文回退。可读警告只适用于必需产物齐全的结果。处理选项与既有文章不匹配时不可冒充重放成功；已有人工改动的文章与批注保持不动。

HTML 转换在 Readability/Turndown 前提取 KaTeX、MathJax、MathML 注解和公式图片中的 TeX，避免视觉层与辅助层重复。通用翻译也保护公式；没有 TeX 时保留原始 MathML/图像并写入 `receipt.conversion_fidelity` 和警告。代码、表格、链接、图片用同一转换器处理。超过快照上限时明确失败，不静默截断。

有 TeX 的网页公式必须在入口转换为 Obsidian 数学语法：行内 `$...$`，独立公式 `$$...$$`，并在 Markdown 转义前保护内部字符。知乎源节点的 `data-eeimg="2"` / `eeimg="2"` 表示独立公式；不依赖是否开启翻译。代码中的美元符号不参与公式处理，已有定界符不重复包裹。

标准处理器的阅读 Markdown 在渲染阶段统一执行 `reader-math-compatibility/v2`，不依赖调用者是否另传 `publishPath`。公式文本命令内的字面 `_` 转为 `\_`，保留数学下标、嵌套数学、代码、链接、来源块和审计哈希；处理可重复执行。处理器 1.12.4 使旧渲染缓存失效，避免重放未兼容的产物。

命中集合规则时，原链接保留为一个父结果，`requested` 仍表示原始输入项数；`results[].collection` 保存枚举进度、冻结文章清单、子批次及逐篇回执，父 `receipt.article_count/imported/failed/warnings` 表示文章数量。文章批次使用同一个 broker 与后台 worker，单批不超过 50 篇。父请求只在完整枚举且逐篇结果全部合格时成功；不能把父项数量误读成文章数量。普通单篇回执保持原样。

请求状态包含 `queued`、`processing`、`completed`、`completed_with_failures`、`requires_browser_auth`、`requires_js_render` 或 `failed`。必须读取逐条结果，不能把 HTTP 202 或整个请求结束视为全部导入成功。`imported` / `idempotent_replay` 结合正式落盘回执判断成功；消费者还须保留 `imported_with_warnings` 或 `receipt.quality_status: "warning"` 的质量警告，不能把可阅读但带警告的 Markdown 当成失败丢掉，或冒充无警告成功。登录或 JS 降级不得冒充成功。

连接失败后的请求重试沿用稳定的 `client_request_id`；收到 `request_id` 后只继续查询。后端终态请求不可变，用户明确重新处理失败条目时创建新尝试 ID，只提交失败项，并保留原失败回执。不得因短暂查询失败重复创建整批任务。网页在同一标签页 sessionStorage 保存当前批次与重试记录。队列状态位于 `.local-ir/browser-import-broker/state.json`，不进入阅读区。正式输出必须使用后端核定的本地目录，不使用 Codex worktree。
