# 渐进阅读｜PDF / EPUB / Word / TXT 原始导入

状态：`0.5.0-canary`。当前支持 PDF、EPUB、DOCX 与 TXT。PDF 正式导入优先接收已经由 MinerU Precision `vlm + OCR + 表格/公式识别` 生成并通过完整性校验的结果；本地文本层抽取器仅作为明确的离线回退，不会静默调用外部服务。旧式二进制 `.doc` 不冒充 DOCX 支持。

## 边界

完整书籍的标准导入应走 `D:\Projects\BookSimplifier\Import-Book.ps1`：默认无导读，最细拆到章，章内小节保留；已有译文用 `-ReuseTranslationRun` 复用。本模块是底层提取器，不以 EPUB 的 XHTML/spine 文件数量决定拆书。整本 EPUB 检测到多个显式章标题时，普通 CLI 会拒绝生成整篇请求并提示正确入口；只有明确要求整本单文件时才使用 `--allow-whole-book-request`。已明确选择的章节入口保持原有范围。

本工程只负责本地文件校验、只读抽取、结构与资源保留、质量标记、原始材料包和下游 request。它不负责导读卡、翻译、阅读器、浏览器、RemNote 或 Logseq。

中文可读内容在最终发布时统一机械繁转简，遵循 [标准处理方案](../standard-preprocessing/docs/processing-plan.md#中文字形规范)。原始包不改字形；标准发布和文学 EPUB 直接发布均调用同一个 OpenCC `t2s` 转换器。脚注、参考文献、图表及表格的说明保留为来源内容。

MinerU 适配器只依据代码语法保护代码声明和方法签名，不把普通英文的阶级、公共服务或私营企业词组标成代码。学术原文中的 `page_footnote`、`ref_text` 和 `chart` 都属于来源内容；页眉、页脚与页码才按既有规则过滤。

`completed` 是唯一可自动进入现有 `pr-preprocess` 接口的来源状态。`partial` 只生成待审 request；`ocr_required` 与 `failed` 不生成下游 request。MinerU 结果入口会验证批次 manifest、`done` 状态、结果 ZIP、根 Markdown、布局 JSON、逐页 content list 和全部图片引用，再重建页锚点与标准原始材料包。

EPUB 的 `--epub-chapter last` 只解析 spine 末项；指向未选章节的内部链接原样保留并计入 `internal_links_out_of_scope`，不冒充已解析锚点。PDF 若检测到覆盖大部分页面正文的“布局表格”，会改按阅读顺序保留文本并标为 `partial`，避免把标题和段落静默压成表格后误报完整成功。DOCX 按文档正文顺序保留标题、段落、列表、表格、外部链接与图片；脚注、修订、批注、公式、文本框、图表或嵌入对象等尚未完整保真的结构会明确降级为 `partial`。

文学 EPUB 使用 `--epub-literature-first-chapters N` 按 NAV/NCX 的真实章节目标选择前 N 章；它支持多个章节共享一个 spine XHTML 的片内锚点结构。`Part`、`Book`、`卷`、`部` 只作为紧邻第一章的上下文标题保留，不计入章数。该入口仅做确定性抽取与清理，不生成翻译、导读卡、摘要或标准语义预处理 request；只有独立验证为 `READY` 时才直接发布到扁平的 `阅读区/Epub/<标题>.md`。

## 包结构

```text
<package>/
  source/original.pdf|original.epub|original.docx|original.txt
  assets/
  raw.md
  source.json
  quality.json
  extraction-result.json
  request.json              # 仅 completed/partial
  manifest.json
```

`manifest.json` 使用 `progressive-reading.rich-text-package/v1`。原文件和包内副本必须拥有相同 SHA-256；现有输出目录不会被覆盖；输出目录必须位于当前渐进阅读工程内。

## 调用

### TXT 纯文本

TXT 沿用相同原始材料包、标准处理路由和发布器。先按 BOM 或严格 UTF-8 解码，非 UTF-8 使用严格 GB18030 并记录编码回退；拒绝空正文、二进制控制字符和替换字符，不使用有损解码。只规范化换行、空行与行首缩进，并转义 Markdown 字面符号；不猜章节层级、不删原文内容、不执行材料中的指令。逐字校验非空白内容覆盖，原 TXT 和包内副本以 SHA-256 核验。

```powershell
$python = 'python'
$env:PYTHONPATH = '.\rich-text-import\src'
& $python -m rich_text_import '<source.txt>' --output '.\imports\rich-text\<material-id>' --language zh --content-profile natural_language --no-reading-guide --json
node standard-preprocessing/cli.mjs --json run --request '.\imports\rich-text\<material-id>\request.json' --output '.\imports\preprocess-runs\txt\<material-id>' --publish '.\阅读区\TXT\<title>.md' --cache 'D:\Caches\pr-preprocess'
```

`--no-reading-guide` 会显式设置 `include_reading_guide=false`，同样适用于其他格式。中文书面材料按最新标准方案默认只做本地规范化，不调用模型；英文 TXT 仍按语言进入现有翻译流程。导读是否启用由调用者选择，不按文件格式强制关闭。

有章节层级的 TXT 全书使用分节入口：全书为文件夹，章及其他上级标题为子文件夹，最末级章节为 `.md`。章前正文、附录说明等上级直属正文单独保存为 `00 开篇.md`，没有下级标题的前言等直接保存为 `.md`。不把正文中的编号列表当作章节。书内未分行的独立标题可以通过 `heading_overrides` 配置原文唯一行前缀、标题与层级；原始段落仍完整保留。每个最末级材料都进入同一个标准预处理器。

```powershell
node scripts/import-txt-book.mjs --request '.\imports\rich-text\<material-id>\request.json' --output '.\imports\preprocess-runs\txt\<material-id>\book' --publish '.\阅读区\TXT\<book-title>' --cache 'D:\Caches\pr-preprocess'
```

可加 `--plan <book-plan.json>` 提供书名或边界配置，`--plan-only` 先生成结构清单。`book-manifest.json` 记录真实层级、行区间、逐节来源哈希与全文覆盖；`book-publication.json` 记录各节实际发布结果。目标书目录已存在时拒绝覆盖。阅读区仅保留分节正文，结构清单和回执放在审计目录。

分节统一粒度：同一组并列章节中，只要有一个节点没有下级标题，该组所有节点都保持完整 `.md`，不单独把某一个节点拆得更深；只有所有并列节点都可继续分时才递归下钻。被保留为整篇的节点仍保留内部标题和全部正文。书根是前言、导言、正文各章、附录等不同结构类别的容器，分别在各自真正并列的组内判断。`book-manifest.json` 中的 `peer_granularity` 保存实际决定及不可再分的并列节点，不按特定书名或附录序号特判。

### 导入与质量记录

沿用既有 `ready / warning / failed` 方案：有可读正文的质量警告不阻止正式进入阅读区。未通过项仅保存到 `result.json`、`publication.json` 等审计日志，不插入正文、前言或提示块。日常导入不使用 `--strict` 作为发布门槛；检查结果与是否完成落盘分别报告。翻译未生成时仍可导入完整原文，日志说明翻译状态，正文不重复附上相同原文。下面旧示例中的 `--strict` 仅用于开发检查，不作为本任务的导入规则。

本任务中的英文 EPUB 章节导入不生成前置导读卡及核心洞察，翻译、原文附后、标准格式和完整性门禁照常执行。可复用 `scripts/import-epub-first-chapters.py <source.epub> --output <new-package-dir> --chapters 1`：它复用现有 TOC 片段抽取器并生成 `standard-request.json`，设置 `processing_options.include_reading_guide=false`，再交给标准 `pr-preprocess`。跨章链接指回原 EPUB。`--resume` 只在原文件及包内清单哈希全部匹配时重建适配请求；原始抽取证据不变。它不采用文学作品的直接发布路线。

使用 ChatGPT 桌面端中的 Codex bundled Python：

```powershell
$python = 'python'
$env:PYTHONPATH = (Join-Path (Get-Location) 'rich-text-import/src')
& $python -m rich_text_import <source.pdf|source.epub|source.docx|source.txt> --output '.\imports\rich-text\<material-id>' --json
```

PDF 正式入口先按全局 `mineru-ocr` Skill 运行 MinerU，再把对应单文件结果目录交给导入器：

```powershell
& $python -m rich_text_import <source.pdf> `
  --pdf-mineru-result '<mineru-run>\<data-id>' `
  --output '.\imports\rich-text\<material-id>' `
  --json
```

不提供 `--pdf-mineru-result` 时才使用本地文本层回退；该回退会合并续行与连续代码块、恢复双栏阅读顺序、过滤装饰图片，并将 JP2 等浏览器不稳定格式转为 PNG。

### PDF 文本层自动对照

PDF/MinerU 正式导入默认运行本地 `pdf_text_audit.py`，不增加 OCR、翻译、导读或其他模型调用。它保存逐页原始文本层，比较文本层与 OCR、OCR 与最终抽取 Markdown，并检查新增的可疑行内代码。数字和大写词差异只作为定位候选，不冒充语义实体识别或确认的 OCR 错误。

- 比较时采用 Unicode、通用繁转简、行尾断词、标点空格和大小写规范化；词/字计数容忍双栏顺序差异，单词内部的小型大写字形字号变化不拆词。
- 页眉页脚、页码和图像/图表/公式内部按真实坐标排除；至少在 3 页且半数页面重复、具有相同字体、字符位置及旋转的水印字形只在对照投影中排除。原始文本层仍完整保留。
- 跨页段落以另一页真实存在的连续五个词/字作为定位证据；全文仍然缺失的内容不能用重复段落解释掉。无文本层、编码损坏的页面标为不可对照，不算 OCR 失败。
- 差异写审计，不插入阅读正文、不自动修改原文、不自动触发额外模型调用或 OCR 重跑。明显漏段先检查脚本映射与现成文本；仅在已有流程确实失败时按其原重试边界处理。
- 包内 `pdf-source-audit/` 包含 `text-layer.json`、`text-layer.txt`、`comparison.json`、`report.md`，纳入 manifest 的文件哈希；`source.json.local_audits` 记录位置。审计不进入预处理 request，不改变导读选项或模型缓存输入。

已导入的 PDF 可只补对照审计，无须重新导入或运行预处理：

```powershell
$env:PYTHONPATH = '.\rich-text-import\src'
& $python -m rich_text_import.pdf_text_audit '<source.pdf>' --mineru-result '<mineru-run>\<data-id>' --markdown '<package>\raw.md' --output '.\imports\pdf-source-audits\<batch>\<id>'
```

输出目录必须是工程内的新目录，拒绝覆盖；原 PDF、原始材料包和阅读文件只读。

只抽取 EPUB spine 的最后一章：

```powershell
& $python -m rich_text_import <source.epub> --epub-chapter last --output '.\imports\rich-text\<material-id>' --json
```

文学 EPUB 前四章直接导入（原始包与验收证据留在 `imports/`，阅读正文保持扁平）：

```powershell
& $python -m rich_text_import <source.epub> `
  --epub-literature-first-chapters 4 `
  --output '.\imports\literature-epub\<material-id>\final' `
  --publish-literature '.\阅读区\Epub\<title> - Part One Chapters 1-4.md' `
  --json
```

文学发布不调用 `pr-preprocess`，包内也不会生成 `request.json`。`literature-validation.json` 记录来源副本哈希、真实章节数、TOC 证据、清理门禁、扁平目标路径及发布哈希；目标已存在时失败且不覆盖。

验证合格 request：

```powershell
pr-preprocess --json validate --request <package-dir>\request.json
```

进入标准前置处理时，把运行审计和最终阅读文件分开：

```powershell
pr-preprocess --json run `
  --request <package-dir>\request.json `
  --output ".\imports\preprocess-runs\pdf\<material-id>" `
  --publish ".\阅读区\PDF\<title>.md" `
  --asset-source <package-dir>\assets `
  --strict
```

EPUB 同理使用 `imports/preprocess-runs/epub/...` 与 `阅读区/Epub/<title>.md`。若所选章节没有本地图片引用，可省略 `--asset-source`。`--output` 绝不能指向阅读区；阅读区交付物必须是分类目录下同级的标题 `.md`，不得使用 `<材料>/reading.md`。

Word 使用 `imports/preprocess-runs/docx/...` 与 `阅读区/Word/<title>.md`。标准发布器会在代码围栏之外删除来源层 HTML 注释、临时来源锚点和不可见控制字符，并拒绝残留 Pandoc fenced div、Pandoc 属性或原始 OOXML；不会删除 Local IR 的 `^pr-...` 正文锚点和 `[[#^pr-...|正文跳转]]`。

## 离线测试

```powershell
$python = 'python'
$env:PYTHONPATH = '.\rich-text-import\src'
& $python -m unittest discover -s '.\rich-text-import\tests' -v
```
