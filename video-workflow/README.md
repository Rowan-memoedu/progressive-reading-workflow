# 视频字幕与图文导入

本模块将完整字幕、经核验的截图和可选 Mermaid 图导入标准预处理及渐进阅读发布流程。字幕和来源证据必须保留，失败和模型输出只写入本机产物目录。

## 模式与依赖

默认处理字幕正文；图文模式必须显式选择 `--type illustrated` 或 `--type 图文模式`。兼容别名 `illustrated_strong` 仍可读取。无可用字幕时保留等待状态，不把简介当正文，不自动下载整段音视频或改用 ASR。

上游 VideoBook 代码由 `fetch-public.py` 按固定提交下载，`upstream-lock.json` 记录来源、Apache-2.0 许可及逐文件哈希。`verifyUpstream()` 在使用前核验；本地适配器不改写上游源码。

```powershell
python video-workflow/fetch-public.py code
```

可选渲染依赖见 `render-requirements.txt`。通过 `PROGRESSIVE_READING_VIDEO_PYTHON` 指定视频 Python 环境，音频/来源工具另支持 `PR_AUDIO_PYTHON`。截图使用隔离的无头 Chrome 播放器与目标站点范围内的临时凭据；退出清除临时凭据。

## 数理课程讲义

带配套板书或讲义的数学、物理等课程可使用独立的 [数理讲义入口](math-lecture/README.md)。该入口将多分 P 的字幕与 PDF 对齐为一份课程目录，按完整例题或推导分单元生成嵌套 lecture；公式使用 LaTeX，保留理由、条件和可达性，不生成导读卡，不执行下述图文截图流程。平台无字幕时可显式选择仅下载音轨并使用现有全局 ASR。各单元分别缓存、审核和恢复，最后整合为一份讲义并核验渲染。

## B 站视频与合集

`watch.mjs` 和 `watch-core.mjs` 发现分 P 与合集，身份为 BV 号加 cid。新订阅默认建立当前基线，之后跟踪新增。已发布、仅后续验收失败的任务在显式恢复时核对原文哈希、来源和附件，再进入 verification-only；普通调度不自行恢复 blocked 项目。

订阅设置与时间以 [统一订阅](../docs/UNIFIED_SUBSCRIPTIONS.md) 为准。不要让旧独立任务和统一调度同时处理同一来源。独立 Windows 调度脚本仍保留给既有安装。

数据目录支持 `PROGRESSIVE_READING_VIDEO_HOME`，产物根目录支持 `PROGRESSIVE_READING_ARTIFACT_HOME`。既有 D 盘目录继续兼容，实际 watchlist、状态与调度回执不随源码发布。

## 来源和内容保护

字幕元数据必须与明确的分 P 一致，临时字幕目录隔离。旧书稿和图片不能混入新来源。`run-authenticated.mjs` 将已有登录快照转换成范围受限的临时 Cookie 文件。

尚未完成的任务在来源字幕、提示词、模型、处理选项或工作流实现变化后，使用最新版本开始一次独立处理。旧目录与证据保留，同一版本重试继续同一目录。新处理只带入该分 P 的原始字幕与来源元数据，不混入旧书稿；已完成的文章继续复用，保留已有正文及批注。

`import-transcript.mjs` 是字幕标准入口；`illustrated-strong.mjs` 处理图文模式。正文、导读、截图和板书校订使用一致的模型路由，模型缓存身份包含实际指令适配版本。Codex CLI 只有报告 `turn.completed` 才能接受结果；无已验证等价项的旧 API 参数不能宣称已应用。

媒体证据按 `source_segment_index` / `result_segment_index` 选择字幕，程序逐字回填引文。时间编译只在已声明窗口内后移或缩短，不扩展场景。Mermaid 和 LaTeX 保留原生 Markdown 语义，不把稀疏配图当作完整公式证据。

## 数学板书

`plan-board-followups.py` 只选择来源字幕索引与需补充的画面；`board-followup-frame.mjs` 规划补图窗口。视觉提取仅报告画面所见，不自行改写字幕。`merge-board-evidence.mjs` 按图像哈希保留各次证据，`assemble-board-ledger.py` 输出待审候选。

校订建议必须精确对应原字幕；不匹配项保留拒绝记录，不通过模糊匹配强行应用。来源缺少定义域或取等条件时不能补算为讲师原话。候选须经过来源审阅与显式准入，图像像素及被接受的字幕修订均可追溯。

后台图文入口 `runWatchedIllustrated` 会自动接续板书阶段：复用原字幕和候选图，分组提取证据，再由独立的实图审阅调用核对。`assemble-board-ledger.py --require-review` 编译候选，`admit-automated-board.py` 从审阅结果重建候选并核验来源及图片哈希后准入；随后继续原强结构化正文、图文定位、导读、来源回读与渲染验收。低层 `importIllustratedStrong` 的待审状态保留供诊断调用，后台不再把这个中间状态直接当作任务结束。

续跑优先使用来源哈希匹配、已包含补图的证据包，复用输入完全一致且独立审阅通过的分组，仅重审失败组。提取缓存、原始响应和已发布成功结果保持不变。Mermaid 的数学比较符在引号标签内统一转为等价实体编码；板书图示修订与初始图示使用同一校验，不把小于号误判为 HTML。

原视频自身的公式冲突、漏讲条件、自我纠正或表述歧义由独立实图审阅记录为 `source_conflicts`，不阻断整份材料。记录绑定精确字幕、同段图片及所见；不补算、不补条件、不替讲师选择一个版本。引用字幕禁止同时修改，并作为受保护的原文片段进入正文；独立重建再次核对。尚不能区分来源错误与识别错误的关键疑点仍须补证据，不能借此分支猜写。

关键证据确有缺口时，后台复用现有补图规划、限时窗口截图和证据合并模块，最多补充两轮。仅新增必要画面，原帧和字幕保持不变；补图后的候选仍须通过独立审阅和来源重建。两轮后仍无法核清的关键条件保持受阻并通知，不补算或猜测。

非关键口头回顾或术语不能由板书核清时，保留原始该条字幕并记录 `retained_uncertainties`，不猜测名称、不向正文添加审计说明。变量、定义域、数值、公式、逻辑关系和取等条件的证据缺口仍阻断。各阶段响应冻结保存，审阅缓存绑定提示词哈希；重复投递和进程恢复只继续尚未完成的阶段，不覆盖阅读文件。

## 多分 P 与附件

先分别提取字幕、截图并完成板书校订，再用 `merge-reviewed-video-parts.mjs` 平移时间轴、重命名截图，同时保持像素和字幕正文。`process-reviewed-collection.mjs` 从合并来源生成一次正文，不把分别改写的正文拼接为新结果。

配套 book.md 中的截图、Mermaid 与附件经过来源清单、媒体布局和发布校验；上游生成的文章不能替代原始字幕正文。`restore-book-media.mjs` 可恢复已核验媒体，不能用缺少证据的新附件覆盖旧稿。

## 验证与恢复

```powershell
node --test video-workflow/*.test.mjs
```

`verify-publication.py` 检查来源、正文、媒体、洞察链接与回执；`verify-collection.py` 检查多分 P 映射；`verify-rendering.py` 独立检查图片、Mermaid 与数学渲染。独立渲染不代表原生 Obsidian 会话已验收。

失败后保留来源、缓存、拒绝项和回执，修复通用流程后重跑原始输入。只恢复已完成阶段，不手工修补成稿冒充自动通过，不覆盖已发布且人工编辑过的内容。
