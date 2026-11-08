# Relingo 式本地英文阅读：Source-led 审计版

更新时间：2026-07-30

## 研究合同

研究问题：

- 是否存在不限于 Obsidian、Logseq 的成品或插件，能对本地英文材料自动只给未知词加中文旁注，并随个人词汇状态逐渐减少注释？
- 哪些实现满足需求，哪些只在架构上值得借鉴？
- 如果没有单一完整成品，哪些开源模块可以组成最小宿主插件？

纳入标准：

- 英文为原文主体。
- 中文释义自动出现在未知词附近。
- 有个人 Known / Learning 等状态，或至少能导入个人难度。
- 本地文件、桌面、本地优先或可迁移架构优先。

排除标准：

- 只有整段双语翻译。
- 只有点击/悬停后弹窗翻译，且没有自动旁注。
- 只有词典或制卡，没有阅读视图。
- 只有产品宣传，无法找到可核验的功能说明。

证据时间边界：

- 本轮页面与仓库核验时间为 2026-07-30。
- 产品功能、价格、提交数和平台支持可能变化，应在安装前再次核验。

## 证据分级

- A：官方文档、官方产品页、代码仓库、许可证、manifest 或源码。
- B：官方商店页面、维护者讨论、可复现演示。
- C：用户社区经验、评测、论坛个案。
- D：搜索摘要、推广页或无法交叉核验的二手说法。

本报告的核心结论主要建立在 A/B 级来源。对产品自述仍单独标注“尚未实测”。

## 核心来源卡

### Jinshu 官网与文档

来源：

- [官网](https://jinshu.built4.fun/)
- [英文文档](https://jinshu.built4.fun/docs)
- [中文文档](https://jinshu.built4.fun/docs-zh)
- [支持页](https://jinshu.built4.fun/support)
- [隐私政策](https://jinshu.built4.fun/privacy)

证据级别：A

直接支持的事实：

- 支持 EPUB、文本型 PDF、Markdown 和网页链接导入。
- 英文词按 CEFR 分层，可只显示高于用户等级的词。
- 提供 ruby、行内括号、点击揭示三种注释样式。
- 自动分析导入文档并标注词汇。
- 有 SRS、上下文句子、Anki 导出。
- iOS 和 Android 可用，本地优先，离线阅读可用。

需要谨慎：

- “符合个人不会的词”部分既来自初始等级，也来自用户后续 Known/Ignore；不是纯行为模型。
- 产品页面无法替代对真实 Markdown、大文件和英汉释义质量的实测。
- 自动短语识别没有得到明确证据。

### Laesi 官网、功能页和方法页

来源：

- [官网与真实阅读视图演示](https://laesi.com/)
- [功能页](https://laesi.com/features/)
- [使用方法](https://laesi.com/how-to-use/)

证据级别：A/B

直接支持的事实：

- Windows、macOS、Linux 原生应用。
- EPUB、MOBI、AZW3、FB2、DOCX、TXT 与多种字幕格式。
- 词汇状态为 Seen、Recognized、Remembered、Known。
- Interlinear Reader 对尚未标记为 Known 的词显示词下 gloss。
- 支持 multi-word lemma。
- 本地 SQLite，无账户、无云端依赖。
- 有词汇导入、Anki 导出、浏览器扩展。
- 99 美元一次性，无桌面试用，30 天退款。

需要谨慎：

- 没有 Markdown 原生支持。
- “未知词词下 gloss”已经确认；“默认 English → Chinese gloss 的质量”未确认。
- Google Translate 与 AI overlay 路线存在，但自动化程度和上下文质量要实测。
- 闭源，不能直接拿代码拼装。

### WordWise GitHub

来源：

- [仓库首页与 README](https://github.com/breeze-r/wordwise)
- [许可证](https://github.com/breeze-r/wordwise/blob/main/LICENSE)
- [扩展目录](https://github.com/breeze-r/wordwise/tree/main/extension)

证据级别：A

直接支持的事实：

- 自动检测网页中不熟悉的英文词，并在原文流中加入中文释义。
- 支持按词汇水平过滤，已会常见词不改动。
- 可标记“认识”或加入生词本。
- 使用 IndexedDB 保存词汇统计、状态与阅读数据。
- Chrome Manifest V3，纯前端架构。
- 本地 ECDICT 派生词典与可选 LLM 回退。
- MIT 许可证。

需要谨慎：

- 项目处在早期，用户量、发布和维护历史不足。
- README 描述与仓库中残留后端结构并存；以当前运行代码为准。
- PDF.js 已用于离屏文本抽取，但不能据此推断完整 PDF 阅读体验已经成熟。
- 未证明能直接处理本地 Markdown 或复杂宿主编辑器。

### Kindle Word Wise

来源：

- [Amazon Word Wise 帮助](https://www.amazon.com/gp/help/customer/display.html?nodeId=201733850)

证据级别：A

直接支持的事实：

- 自动在困难词上方显示简短定义。
- 用户可调节提示数量。

需要谨慎：

- Kindle 书籍与设备兼容受格式、商店和地区影响。
- 它更像难度模型，不是 LingQ 式个人词汇画像。
- 官方资料并不证明能直接处理 Markdown。

### WordDumb

来源：

- [GitHub](https://github.com/xxyzz/WordDumb)
- [文档](https://xxyzz.github.io/WordDumb/)
- [使用说明](https://xxyzz.github.io/WordDumb/usage.html)
- [Word Wise 数据库结构](https://xxyzz.github.io/WordDumb/contributing/word_wise_db.html)

证据级别：A

直接支持的事实：

- Calibre 插件，为 KFX、AZW3、AZW、MOBI 和 EPUB 生成 Word Wise/X-Ray。
- EPUB 可直接加入 Word Wise 注释。
- 可以自定义难度和释义。
- 支持中文 definition language。
- 可从 Anki、Kindle Vocabulary Builder、CSV 导入难度，并导出 Anki。
- GPLv3+。

需要谨慎：

- 是电子书预处理管线，不是动态笔记插件。
- Kindle 中文 Word Wise 数据库存在设备、账户和数据库替换注意事项。
- 用户画像需要外部来源导入，不是全自动闭环。

### KOReader wordwise.koplugin

来源：

- [GitHub](https://github.com/asxelot/wordwise.koplugin)

证据级别：A

直接支持的事实：

- 在原书页面上绘制 per-page overlay，不改写文件。
- 为困难词显示词上简释。
- 有 1–5 级提示密度。
- 可使用自定义 SQLite 词典，并处理部分词形变化。

需要谨慎：

- 默认定义和词汇难度不等于个人词汇状态。
- 未发现明确许可证；在获得许可前只能参考思路，不能直接复制实现。
- 项目规模小，兼容性与长期维护需实测。

### Lector

来源：

- [GitHub](https://github.com/heuwels/lector)

证据级别：A

直接支持的事实：

- 自托管语言学习阅读器。
- 支持 EPUB、Markdown。
- 有单词状态、SRS、Anki 双向复习和本地 SQLite。
- AGPLv3。

需要谨慎：

- 核心是点击取词，不是自动中文旁注。
- 如果直接复制 AGPL 代码，最终分发许可需要相容。

### WordByWord

来源：

- [官网](https://wordbyword.io/en)

证据级别：A/B

直接支持的事实：

- 可用于网站、PDF、YouTube。
- Spotlight 会预先突出可能未知词。
- 有从 unknown 到 mastered 的词汇状态和智能卡片。

缺口：

- 释义仍依赖点击或悬停，不是自动中文旁注。
- 闭源、账户型产品。

### VocabTracker

来源：

- [帮助文档](https://www.vocabtracker.com/help.html)

证据级别：A

直接支持的事实：

- 受 LingQ、LWT、Readlang 启发。
- 支持网页和 PDF、Word、TXT 导入。
- 支持 lemma 与多级词汇状态。

缺口：

- 主要是颜色状态与点击/选择翻译。
- 不能替代 Relingo 式自动内联中文。

### Readeri

来源：

- [官网](https://readeri.com/)

证据级别：A/B

直接支持的事实：

- 支持 EPUB、PDF、FB2、TXT、RTF、HTML、DOCX 和 Markdown。
- 有多级掌握度、词汇训练和统计。

缺口：

- 翻译是点按交互。
- 是浏览器/云端阅读服务，不是本地笔记插件。

### Readlang

来源：

- [功能页](https://readlang.com/features)
- [关于页](https://readlang.com/about)

证据级别：A

直接支持的事实：

- 网页扩展与 TXT/EPUB 导入。
- 点击单词或短语后在原位置显示翻译。
- 查过的词进入词表和复习，可导出 Anki。

缺口：

- 点击后才翻译。
- 主要记录用户查过的词，而不是自动标注个人未知词。

### Migaku

来源：

- [官网](https://migaku.com/)

证据级别：A/B

直接支持的事实：

- 有 Unknown、Learning、Known、Ignored、Tracking 状态。
- SRS 与阅读/媒体工作流连接。

缺口：

- 不是未知词自动中文旁注。
- 闭源；数据可携带性和价格需另行核验。

### WordHunter

来源：

- [GitHub](https://github.com/Ironship/WordHunter)

证据级别：A

直接支持的事实：

- Tauri 本地优先桌面阅读器。
- 支持 PDF、EPUB、文本、字幕与 URL。
- 有词汇状态、SRS、OCR 与本地数据。

缺口：

- 未确认自动在未知词旁显示中文。
- 适合做桌面壳和格式接入参考，不是直接答案。

### Lute

来源：

- [GitHub](https://github.com/LuteOrg/lute-v3)

证据级别：A

直接支持的事实：

- MIT，本地自托管。
- 有 New、Learning、Well-known、Ignore 等状态。
- 可维护个人语料和词汇数据库。

缺口：

- 阅读时以颜色和点击查词为主。

### asbplayer

来源：

- [GitHub](https://github.com/killergerbah/asbplayer)

证据级别：A

直接支持的事实：

- MIT。
- 可以根据 Anki、WaniKani 或本地状态对词应用样式。
- 支持本地媒体、字幕与浏览器扩展。

缺口：

- 不是一般 Markdown 长文阅读器。
- 适合参考外部复习状态回流到阅读呈现。

### Yomitan

来源：

- [GitHub](https://github.com/yomidevs/yomitan)

证据级别：A

直接支持的事实：

- 成熟浏览器词典、词典导入、Anki 集成与文本扫描架构。
- GPLv3。

缺口：

- 主交互是扫描/弹窗，不是自动未知词中文旁注。
- 项目重点并非中文母语者学英语。

### Libera Parallel Text Reader

来源：

- [App Store 页面](https://apps.apple.com/ca/app/libera-parallel-text-reader/id943767191)
- [Libera 官方站](https://www.libera-app.com/homejp)

证据级别：A/B

直接支持的事实：

- 选择一侧的词或短语时，同时高亮另一侧对应片段。
- 文本按词或短语建立对齐关系。

缺口：

- 它是预制平行文本阅读器，不做个人未知词自动旁注。
- 不能直接证明任意本地 Markdown 的自动对齐质量。

架构价值：

- 为延期的“英中双向跟随选中”提供 segment alignment 与双视图事件同步参考。

### Operaide Translator

来源：

- [官方 Showcase](https://operaide.ai/showcase/translator)

证据级别：A/B

直接支持的事实：

- PDF.js 提取带位置元数据的文本片段。
- 原文与译文并排显示并同步高亮。
- 翻译结果以片段为单位保持源目标映射。

缺口：

- 是整篇翻译和 PDF 重建工作流，不是未知词学习阅读器。
- 适合借鉴选中映射，不能作为核心需求成品。

## 广泛扫描后排除或降级的候选

以下产品可能有价值，但未进入第一层：

- Relingo：浏览器端目标体验基准，但不能解决大量本地文件和笔记宿主问题。
- Immersive Translate：段落双语、DOM 注入与缓存值得参考，核心呈现不符合本需求。
- Read Frog：可参考网页解析、翻译服务和学习组件，核心不是个人未知词旁注。
- LingQ：个人词汇状态和长期学习闭环基准，但原文内自动中文旁注不是其主要呈现。
- LanguageCrush：有 known/learning/unknown，但释义仍以点击为主。
- Elreader：EPUB/PDF 和词汇状态齐全，但不是自动旁注。
- Smart Book：并行/点按翻译和词汇本，不是未知词过滤。
- Instant Book Reader：本地文件与词汇功能，但仍是点击查词。
- Kalima：宣传包含 Markdown 和语言学习阅读，但产品可用性不足。
- NeonLingo：浏览器跨站词汇本与等级筛选，但不是本地文件宿主。
- VocaSpot：CEFR 自动高亮新闻词，释义仍需点击。
- LearnJargon：有个性化网页词汇提示，但方向、数据模型和本地文件能力证据不足。
- Bingy：字幕内未知词译注接近目标，但内容域和目标语言不符。
- LWT：经典个人词汇数据库架构，界面与自动旁注不命中。
- FLTR：本地辅助阅读与词汇状态，但项目老旧、呈现不命中。
- Learning With Texts 衍生项目：可参考数据模型，不能作为当前成品。
- Language Reactor：视频字幕学习强，不解决本地 Markdown。
- Toucan：网页词汇替换式学习，不是中文 gloss。
- Mate Translate：全局翻译入口，不做个人未知词过滤。
- Rememberry：翻译与卡片，不做自动旁注。
- Definer：词典弹窗，不做个人词汇闭环。
- GlotDojo：字幕/网页学习，不是本地 Markdown 生词旁注。
- Readwise Reader：文档聚合与高亮强，但不实现目标词汇呈现。
- Calibre Viewer：格式与本地阅读强，需 WordDumb 等插件补齐 gloss。
- KOReader 核心：本地阅读器强，需 wordwise.koplugin 和个人状态层。

排除不代表产品差，只表示“不是本轮需求的直接答案”。

## 已核实事实、产品自述、推断

### 已核实事实

- Jinshu 文档明确列出 Markdown 导入和多种自动注释显示样式。
- Laesi 官方演示明确描述只给未标 Known 的词显示 gloss。
- WordWise 代码仓库和 README 明确描述自动未知词内联中文与本地词汇状态。
- WordDumb 文档明确支持中文 Word Wise、个人难度导入和 EPUB 等格式。
- KOReader 插件明确采用不改原书的逐页 overlay。

### 产品自述，尚未独立实测

- Jinshu 在长 Markdown、复杂排版和中文释义消歧上的实际表现。
- Laesi English → Chinese interlinear gloss 的默认可用性。
- WordWise 当前代码与 README 所述全部功能的一致性。
- 各产品跨设备同步、性能和长期稳定性。

### 研究推断

- Jinshu 是当前功能匹配最强的成品，但不是 Windows 笔记宿主。
- Laesi 是当前 Windows 最有希望的直接路线，但必须先验证中文。
- WordWise 是最合适的开源核心，因为它同时命中“自动筛词、中文内联、Known 状态”。
- 最小自研应把核心引擎与宿主适配分离，首个宿主确定后只写一个薄插件。
- 自动短语旁注会是组合方案中最需要额外研发的部分。

## 反方论证与失败模式

### “直接用 Jinshu 就结束”

反方：

- 用户大量阅读可能仍发生在 Windows。
- 导入式阅读会造成阅读位置、笔记和知识库上下文分离。

成立条件：

- 移动端/墨水屏能承担主要长文阅读。
- 笔记回流可以接受摘录导出，而不要求原位编辑。

### “直接买 Laesi”

反方：

- English → Chinese gloss 未实测。
- Markdown 需要转换。
- 闭源产品若停止维护，宿主和数据迁移依然有成本。

成立条件：

- 同一批真实材料验证通过。
- CSV/SQLite/Anki 等数据出口满足长期可迁移性。

### “直接 fork WordWise”

反方：

- 项目早期，文档和代码可能变化快。
- 浏览器 DOM 与笔记软件编辑器的装饰 API 差异很大。
- 短语、上下文消歧、复杂 Markdown 和性能仍要补。

成立条件：

- 最终宿主已经确定。
- 首版只做阅读视图，不碰编辑模式与源文件改写。

### “批量改写 Markdown 最简单”

反方：

- 中文注释会污染源文件。
- 词汇状态变化后需要全量重写。
- Git diff、引用、定位和跨软件显示都会变差。

更安全的替代：

- 保存 sidecar JSON/SQLite，并在阅读时生成派生视图。
- 用户已经允许首版写入原文；若采用这条路线，使用明确可逆的注释标记、写前备份和撤销验证。
- 更稳妥的默认仍是输出到独立派生目录，不覆盖原文。

## 最小 canary 验收

使用同一篇 1,500–3,000 词的真实英文 Markdown，包含：

- 10 个明确已会词。
- 10 个明确不会词。
- 5 个多义词。
- 5 个短语动词或习语。
- 标题、列表、链接、代码段与引用。

逐项检查：

- 已会词不出现中文。
- 不会词自动出现简短中文。
- 标记 Known 后当前页面立即消失，重开文档后仍然消失。
- 标记 Learning 后跨文档保持。
- 代码、URL、标题锚点不被破坏。
- 多义词至少不出现明显错误义项。
- 短语不能被错误拆成误导性单词释义。
- 覆盖层/派生视图路线：原 Markdown 哈希不变。
- 直接写入路线：diff 只包含预定义注释标记，撤销后原文哈希恢复。
- 状态可以导出或备份。

停止条件：

- 核心旁注必须依赖逐词点击。
- Known 状态不能跨文档保留。
- 中文 gloss 错误率明显干扰理解。
- 处理后破坏 Markdown 或导致编辑卡顿。

## 证据支持下的最终结论

- 直接成品不是零：Jinshu 与 Laesi 已经覆盖大部分核心体验。
- 开源核心不是零：WordWise 明确实现目标浏览器行为，并采用 MIT。
- 本地批处理与覆盖层也已有成熟方向：WordDumb 和 KOReader 插件分别代表两条路线。
- 真正缺失的是这些能力在一个成熟 Windows 本地 Markdown/笔记宿主中的统一产品。
- 因此，如果成品 canary 不能覆盖实际阅读位置，后续开发应是“组合已有模块 + 一个最终宿主适配器”，而不是重新设计整个语言学习平台。
