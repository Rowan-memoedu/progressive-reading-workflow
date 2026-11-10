# 标准 Markdown 前置处理接口

这是 `原始 Markdown + 来源元数据 + 用户补充指令` 到 Obsidian Local IR 最终阅读 Markdown 的来源中立接口。它不抓取网页、不控制浏览器、不实现 Local IR UI，也不写入 RemNote 或其他知识库。

2026-10-07：连续的强结构化大纲按顶层主题子树建立正文块，保留子项归属和原文内容；导读使用这些块定位，不再把整篇大纲当作一个块。相邻列表会在 Obsidian 中合并，因此单一主题列表的锚点放在主题行上，遵循[列表项原生锚点语法](https://obsidian.md/help/links)。已生成稿的链接可用 `node tools/repair-outline-navigation.mjs --result <原 result.json> --publish <阅读稿.md> --output <D盘审计目录>` 本地修复，保留洞察文字与正文，不调用模型；无法找到足够或唯一的来源证据时停止。只核对候选定位时省略 `--publish` 和 `--output`。发布要求当前文件哈希与审核输入一致，审计保留原稿；普通发布仍拒绝覆盖冲突目标。

## 稳定入口

LLM 后端默认使用 **Codex Exec**，使用现有 Codex CLI 登录态，无需 DeepSeek Key；未登录或调用失败会报告错误，不自动改用另一个后端。正式导读阶段只允许 Codex Exec，显式配置其他后端时停止。分类、正文整理和翻译保留原有后端选择；进程环境变量、Windows 用户环境变量、`AI_PRODUCER_CONFIG` 配置文件、默认值依次决定实际配置。

VideoBook图文模式已统一接入此路由，并额外要求Codex Exec：媒体计划、强结构化正文、板书图片校订、图文定位及导读均不允许绕行API。统一调用支持本地图片，Codex通过CLI图片参数接收实际像素；仅有文件名或OCR不算图片输入。图文模式遇到显式API后端配置时停止报错。Python适配器 `producer_transport.py` 只通过既有stdio桥调用此模块，不持有独立模型配置或API凭据。

DeepSeek 继续使用 `AI_PRODUCER_BASE_URL`、`AI_PRODUCER_MODEL` 和专用 `DEEPSEEK_READING_API_KEY`。Codex 默认固定使用 `gpt-6-luna`，可单独设置 `AI_PRODUCER_CODEX_MODEL` 覆盖；已有 DeepSeek 模型名不会传给 Codex。`AI_PRODUCER_CODEX_BIN` 可指定 codex.exe。Codex 运行在 D 盘临时目录，以只读模式接收 stdin，并从最终消息文件读取结果。原始模型响应缓存按后端与模型隔离；已完成材料的幂等结果保留，不自动重做旧导入。`pr-preprocess --json doctor` 可核对当前后端及登录状态。CLI 也支持 `--provider deepseek` 或 `--provider codex_exec`，仅覆盖本次调用，例如 `pr-preprocess --provider deepseek --json doctor`。

全文调用另使用 `prompts/source-preservation-protocol-v1.md` 说明原文保护标记的保留规则，并冻结协议、实际调用提示词及各自哈希。“强结构化整理”现对齐共享非写作提示词，直接进入整理，不调用写作判断；图片、公式、代码的保留协议继续优先适用。缓存身份包含提示词和协议哈希，既有失败响应不自动重发。缺失或重复原文片段仍停止发布；该约束同时用于普通书面化和强结构化。

视频配套图文：普通书面化与强结构化整理都将输入已有的 Mermaid、LaTeX、代码与图片嵌入作为保护片段原样保留。只有字幕文字、而图表位于配套 `book.md` 的材料，须先走 [VideoBook 图文保留补丁](../video-workflow/README.md#配套-bookmd-的图文保留补丁)，把原生图块与正文图片嵌入带入同一输入。视频发布采用 `<标题>/<标题>.md` 与同级 `images/`，图片使用 `![说明](images/文件.png)`；其他文件按需用附件链接，未用文件只保留。该步骤不改提示词、不增加模型调用，也不生成文末附件列表。下文一般资料的发布目录规则不覆盖这一视频目录约定。

**当前处理方案（2026-10-01，处理器 `1.12.0` / 接口 `1.3.0`）**：先读取人工注入的类型与各项 `true / false`，只补影响剩余选择的缺失分类。普通文章默认开启导读，数理讲义和文学默认关闭；显式选择优先。书面材料默认本地规范化，正文、翻译和最终导读分开执行与缓存；关闭导读意味着不生产导读数据。分类不足返回可恢复的 `needs_classification`。完整规则与入口见[处理方案](docs/processing-plan.md)。

**当前翻译与导读验收（2026-10-01）**：所选译文、导读必须实际生成，原文回退和占位说明不算完成。不按英文比例、单块中文、导读字数、洞察数量或文风重试。翻译仍保留全文目标语言与来源覆盖检查，通用文章和数理讲义都保护公式、代码和链接。原始失败请求与独立格式样例的证据位于 `D:\Artifacts\ProgressiveReading\import-repair-20260930`。

日常导入使用 `ready / warning / failed`：必需产物齐全的可读 `warning` 才允许发布，缺少所要求的译文或导读则停止。未通过项只写审计，不掺入阅读正文。发布器复用 `scripts/standard-import-quality.mjs` 与 `lib/required-artifacts.mjs`；`include_reading_guide=false` 对所有标准路径生效，等待分类时不发布文件。

用户明确要求只保留现成译文、不取得英文正文时，来源适配器可设置 `source_metadata.translation.existing_translation_only: true`，同时保留 `is_translation: true` 和真实 `original_url`。该输入返回 `preserved_translation`，不要求双语对齐、不重新翻译，仍按选择生成导读；缺少原文链接继续隔离。普通译文或已有双语输入不受此显式选项影响。

标准工作流的正文处理仍分为全文口语转书面与显式强结构化整理，正文只生产一次；不因导读失败重写正文。正式导读共用 `guide-coverage/v2` 和 `guide-fidelity/v1`：先依据原文建立带证据与观点身份的信息点清单，由程序固定身份，再分段提取、整篇删重、独立保真核验和覆盖核验。补漏或修正后再次删重并复核覆盖；同描述、同跳转的重复组由程序列明，保留多条必须说明标题独有的原文命题，不能仅换标题重复。每一步均提供全文语境，补漏使用原段落及全文，不截取孤立句子。网页、视频、PDF、EPUB 和文本标准导入共用这一入口；关闭导读则完全跳过。

洞察只能表达原文观点，允许直接摘取原句。保留量词、数字、条件、因果、否定、判断力度以及作者、引述、反驳和假设的区别；不添加原文没有的免责声明、边界或平衡意见。核验针对观点差异和真实跳转依据，不按文风或字面重复率评分。覆盖审计只引用冻结的信息点 ID，不能重写清单；保真未通过时只修复相关洞察，不能作为警告放行。结构响应最多校正一次，并带回具体错误、要求的编号和上一轮实际输出。覆盖核验最多三轮，每轮候选的每条洞察最多修正两次，修正后必须重新核验，仍不合格就保存失败现场并停止发布；不会因为其他洞察此前用过修正次数，就跳过新发现问题的修复机会。详见 [处理方案与提示词](docs/processing-plan.md#模型调用与复用)。

导读阶段缓存默认位于 `D:/AppData/ProgressiveReading/guide-coverage`，可由进程变量 `PR_GUIDE_COVERAGE_CACHE_DIR` 指定。缓存绑定来源、选项、后端、模型、传输和覆盖版本，保存生成结果、冻结清单及核对记录。只重试失败阶段；不覆盖既有阅读文件，不重跑已完成正文或翻译。关闭导读时完全跳过。

导读各次模型调用使用 Codex Exec 原生 `--output-schema` 约束 JSON 字段与编号；原文保真、完整覆盖和跳转仍由独立核验决定。整篇核验不继承分段生成的范围限制，同一命题的多处出现可以由一条忠实洞察覆盖。该结构约束只作用于导读，正文调用与强结构化提示词保持原样。

翻译语义策略从 `D:\Artifacts\TranslationPrompts\general-translation.txt` 动态读取（可用 `PR_TRANSLATION_PROMPT_PATH` 指定其他文件）；该文件是通用单一提示词的唯一编辑入口。工作流只追加 JSON、保护符和分块输出适配，主路径与回退路径共用策略，并提供全文叙述上下文（公式等字面语法保持遮罩）。提示词 SHA-256 纳入翻译阶段的缓存键及 `receipt.prompt_version`，改动后不复用旧翻译缓存。当前在旧 PDF 提示词上增加整体上下文说明；普通英文路径使用语义分组和连续 Markdown 字符串翻译，位置标记由本地恢复原块对应。低保留实验版仍弃用；不能将减少英文残留作为单独的质量目标。早期失败与提示词实验保留在原审计目录，不能覆盖上述现役规则。选择 DeepSeek API 时显式使用 `thinking.type=disabled` 和专用 `DEEPSEEK_READING_API_KEY`；默认后端为 Codex Exec。

安装后可从任意目录直接调用：

```powershell
pr-preprocess --json doctor
pr-preprocess --json validate --request <request.json>
pr-preprocess --json run --request <request.json> --output <audit-run-dir> --publish <final.md> --strict
```

项目内兼容入口仍可使用：

```powershell
npm run preprocess -- --json run --request <request.json> --output <audit-run-dir> --publish <final.md>
Get-Content -Raw request.json | npm run preprocess -- --json run --request - --output <audit-run-dir> --publish <final.md>
```

程序化调用：

```js
import {
  buildPreprocessRequest,
  runPreprocessingRequest,
  standardWorkflowOptions
} from "web-markdown-import-workflow/preprocess";

const request = buildPreprocessRequest({
  markdown: rawMarkdown,
  sourceType: "youtube_video_transcript",
  sourceMetadata,
  userInstruction: "",
  processingOptions: standardWorkflowOptions()
});

const run = await runPreprocessingRequest(request, {
  outputDir: auditRunDir,
  publishPath: finalMarkdownPath,
  assetSourceDir
});
```

`--output` 是审计运行目录，固定包含 `request.json`、`result.json` 和 `run-manifest.json`；正常结果另有审计副本 `reading.md`，缺原文链接的译文另有 `quarantine.md`。它应位于 `imports/preprocess-runs/...`，不得放在 `阅读区`。`--publish` 指定阅读区内一个精确的最终 `.md` 文件，例如 `阅读区/PDF/材料标题.md`；禁止用“材料文件夹 + reading.md”作为交付格式。正文若引用相对 `assets/...` 图片，须同时提供 `--asset-source`，接口会发布到 `阅读区/<source>/_assets/<标题>/` 并改写链接。成功发布后，审计目录另有 `publication.json`。

`result.json` 最后原子提交，是处理调用完成标记；`publication.json` 和最终 `.md` 是发布完成证据。调用方必须先看 `result.json.status`、`processing_state` 和 `artifacts.target_zone`，不能仅凭 Markdown 文件存在判断成功。

发布前还会执行确定性的最终文本清理：删除代码围栏之外的来源层 HTML 注释、PDF/EPUB/DOCX 临时锚点、软连字符和零宽控制字符；能映射到 Local IR block id 的内部来源链接会改写为标准正文跳转。若仍残留 Pandoc fenced div、Pandoc 属性、原始 OOXML 或 Unicode replacement character，发布失败，不把中间产物交付到阅读区。标准 Markdown、代码围栏、表格、链接、图片、公式及 Local IR 的 `^pr-...` 块标识不属于冗余中间语法。

可读文本中的繁体中文统一在共享发布环节使用 OpenCC `t2s` 机械转为简体，原始包与审计证据不变，代码、公式、URL 和路径等字面语法保持原样。范围与原文覆盖验收见[中文字形规范](docs/processing-plan.md#中文字形规范)。

## 命令与 JSON 合同

- `doctor`：只读检查 Node、Schema、外包配置来源与默认缓存目录；不打印密钥。
- `validate`：只做请求 Schema 和运行时跨字段校验；不调用 AI、不写文件。
- `run`：调用生产、验证结果 Schema、确定性渲染并原子落盘。`--output` 保存审计运行包；`--publish` 发布一个平铺的最终 `.md`；`--asset-source` 仅为发布本地图片时使用。`--dry-run` 等价于只验证；`--no-write` 只返回摘要；`--strict` 要求结果确实可进入 `local-ir-reading`。
- `--json` 成功统一返回 `{ ok: true, command, ... }`；错误统一返回 `{ ok: false, command, interface_version, error: { code, message, details } }`。stdout 只包含 JSON，不包含密钥或进度文本。
- 默认共享缓存目录是 `%USERPROFILE%\.pr-preprocess\cache`，可用 `PR_PREPROCESS_HOME` 或 `--cache` 覆盖。相同输入、合同、处理器和 prompt 会命中同一幂等结果。

两个来源工程的最小接入说明见 [网络内容导入](integrations/NETWORK_IMPORT.md) 与[浏览器采集](integrations/BROWSER_CAPTURE.md)。

## v1 核心保证

- `standard` 工作流按[处理方案](docs/processing-plan.md)执行：显式选择 > 类型默认；模型只补必要缺项。分类信息不足时返回 `needs_classification`，不反复猜测。
- 正文处理、翻译与最终导读分别缓存。翻译后附原文；已双语材料默认保留且不重复翻译。`receipt.workflow_route` 保存每项决定及实际执行顺序。
- 本地负责规范化、Schema、保护符、覆盖、哈希、锚点和渲染；仅启用且需要内容理解的步骤调用模型。
- `standardMarkdownOptions`、`spokenMarkdownOptions`、`sourceTranslationOptions`、`mathLectureTranslationOptions` 和 `mathLectureStandardizationOptions` 保留为兼容的单阶段入口；来源工程的新接入应使用 `standardWorkflowOptions`，不要自行复制分类、翻译或结构化规则。
- `math_lecture` 翻译先对当前材料做领域术语盘点，再翻译一般叙述。术语盘点覆盖定义项、命名算法、数据结构、数学/CS 概念、人名、缩写和原文标签；候选必须逐字存在于当前输入，拿不准译法时保留英文，不使用单一 Canary 的固定词表或句式替换。
- 正式调用不按重试次数创建 `vNN` 目录。调用方为同一材料在 `imports/preprocess-runs/...` 选择一个稳定审计目录，并为阅读区指定一个稳定的同级 `.md` 发布路径。接口在内部完成校验与最多三次重试；过程版本只进入 receipt，不落成一串候选文件。显式调试快照不属于生产合同。
- `material_id` 表示材料身份；给同一译文补充 `original_url` 或 `original_markdown` 不改变其自动派生身份。
- `idempotency_key` 覆盖输入正文、注入原文、来源元数据、合同版本和用户指令；处理条件变化会生成新键。
- 兼容的单阶段 `source_voice_structuring` 对普通 Markdown 做来源保真清洗；口述稿、字幕和 ASR 转写可显式使用 `lossless_spoken_to_written`。标准工作流无需调用方预先选择这些阶段。
- `lossless_spoken_to_written` 要求每个源 block 恰好覆盖一次；最终阅读 Markdown 只呈现清洗正文，逐块原句、处理状态、原因和正文去向保存在 `artifacts.cleaning_manifest`，可独立审计。
- 受控生产器若返回清洗结果，只能使用必要的稀疏补丁；未修改正文由本地补回。
- 稀疏补丁不得改动代码、伪代码、LaTeX 或行内代码；本地校验后才接受。
- 视频字幕可启用原视角、无时间码、内容标题和材料主张归因四项硬门；导读层归因不改变正文的第一人称表达。
- 正文 block id 和洞察跳转由本地确定性渲染器生成，模型看不到也不能猜；每个跳转单独放在对应洞察描述的下一行，不集中到文末。渲染收尾阶段只保留被前置卡实际引用的可见正文锚点，未引用 block id 仍完整保存在 `artifacts.body_blocks` 与清洗映射中，但不再污染 `reading.md`。
- 每个洞察跳转链接下方必须保留一个空行；是否继续阅读采用五档：`0 不值得读`、`1 一句话核心`、`2 概览与关键结论`、`3 全文`、`4 精细阅读`。
- 阅读前置卡的价值判断和信息密度判断分别采用五档：`极低`、`低`、`中`、`高`、`极高`；`中`只用于证据确实居中，不作为不确定性的默认档位。
- 洞察标题、描述须非空，跳转指向真实正文块；不设字数或洞察数量门槛。
- 请求与结果必须分别通过 `contracts/request.schema.json` 和 `contracts/result.schema.json`。结果合同会检查正常区/隔离区产物形态、正文块、语义层、清洗 manifest、哈希、receipt、校验项和错误结构，不把这些字段留作任意对象。
- `insight_soft_min <= insight_soft_max <= insight_safety_cap` 是运行时跨字段硬门；单字段类型和范围同时由请求 JSON Schema 检查。
- 缺原文链接的译文返回 `quarantined`，不产生正常阅读区文件。
- 失败阶段有限重试后内部保留原文与审计；缺少所选译文或导读时不发布到阅读区，也不伪称翻译成功。

完整合同见 [接口说明](../docs/STANDARD_MARKDOWN_PREPROCESSING_INTERFACE.md)。

生产、校验、定点修复、必跑语义审计、确定性渲染与严格失败路由见[处理闭环 v1](docs/processing-loop-v1.md)。运行时不依赖 Codex Subagent；开发期 Subagent 只承担隔离实现、审查和 Canary。

## 验证

```powershell
npm run preprocess:test
npm run preprocess:canary
npm run preprocess:canary:live
```

默认 canary 只用 `fixtures/` 中的合成材料，不调用外部 AI。`preprocess:test` 会实际编译两份 JSON Schema，并让四种 fixture 请求及其离线结果通过合同校验。`preprocess:canary:live` 仍只用合成材料，但会调用已配置的低成本外部 API，以验证真实调用、校验和重试闭环。两者都不读取真实私人材料。

live canary 可临时用 `AI_PRODUCER_TIMEOUT_MS` 收紧单次 HTTP 请求上限；正式默认值为 180000 毫秒。

## 媒体标记的确定性恢复

导读目标引用也有受限的本地恢复：仅当无效 key 的原块序号不变、洞察描述中至少两段不重叠的连续 8 字符原文证据唯一指向同一正文块时，恢复该块的真实 key。有效 key 不改；多解、证据不足或序号冲突继续拒绝。原模型响应与正文、洞察文字不改写，恢复证据进入调用用量审计，再走原有引用校验。回归：`node --test standard-preprocessing/test/guide-target-recovery.test.mjs`。

正文整理后的媒体投影会把行内的图片和多行原生代码标记分离为同级列表项，保留文字、媒体顺序和原始内容，避免 Mermaid 围栏无法解析。强结构化整理若遗漏图片，仅允许在两个唯一、顺序一致的原文媒体锚点之间恢复；缺失图表、缺少边界、重复或重排仍拒绝发布。模型原始响应不修改，恢复记录写入审计目录，不重新请求模型。

