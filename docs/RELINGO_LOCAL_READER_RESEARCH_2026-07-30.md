# Relingo 式本地英文阅读：替代方案决策阅读版

更新时间：2026-07-30

## 结论

此前把搜索重点放在 Obsidian、Logseq 和“双语段落”插件上，是范围判断错误。真正需要搜索的是一种跨宿主的阅读机制：

- 英文原文保持主体。
- 系统自动判断当前不会或正在学的词。
- 只在这些词旁边自动显示中文短释义。
- 已会词不加注释；用户标记“会了”后，后续页面逐渐变干净。
- 阅读行为、生词状态和复习结果持续更新个人词汇画像。

按这个定义，已经找到真正命中或高度接近需求的产品，不需要从 Obsidian 插件市场里硬找：

1. **Jinshu**：当前功能命中度最高，直接支持本地 Markdown、PDF、EPUB；缺点是仅 iOS/Android，不在 Windows 笔记软件里运行。
2. **Laesi**：当前 Windows 桌面体验最接近。其 Interlinear Reader 会在“尚未标为 Known”的词下显示 gloss，并有多级熟练度、本地 SQLite、Anki 与浏览器扩展；缺点是不原生支持 Markdown，英译中 gloss 的实际质量仍需小样测试。
3. **WordWise**：目前最值得复用的开源代码基座。它明确实现“自动识别不熟悉词 → 原文内联中文 → 标记认识 → IndexedDB 词汇状态/SRS”；缺点是项目很新，成熟度低，当前主要是浏览器扩展。
4. **WordDumb / Kindle Word Wise / KOReader Word Wise**：适合参考“离线批量预处理”和“阅读器覆盖层”，但没有完整的 LingQ 式个人词汇闭环。

因此，当前判断不是“没有符合需求的实现”，而是：

- **有可立即试用的成品。**
- **有完整命中核心交互的开源浏览器实现。**
- **仍没有确认成熟、Windows 本地、原生 Markdown/笔记软件内运行、并完整覆盖个性化闭环的单一产品。**
- 如果最终要开发，应采用“现成核心 + 薄宿主适配层”，不应从零写一个大型通用插件。

## 目标需求与验收口径

### 当前必须满足

- 目标语言是英文，母语释义是中文。
- 原文必须保持英文主体，不能改造成整段中英对照。
- 生词中文必须自动出现在词旁、词上或词下，不以点击后弹窗作为主要阅读模式。
- 显示密度必须受个人已知词状态控制，而不只是固定 CEFR 阈值。
- 能明确标记 Known / Learning / Ignored 等状态。
- 状态应跨文章积累，使用越久，注释越少、越符合个人情况。
- 能处理本地阅读材料；Markdown 是重要输入格式。

### 单独评分、暂不阻塞

- 选中英文时同步选中对应中文，反向亦然。
- 是否直接运行在 Obsidian、Logseq 或其他最终笔记软件内部。
- 是否能把注释无损写回原 Markdown。
- 自动识别多词短语、习语和上下文义项。

已确认用户允许首版直接写入原 Markdown；这是一项许可，不代表技术路线必须改写原文。研究中仍把“派生视图/sidecar”和“直接写入”作为两条可选路线评分。

### 明确不再采用的错误口径

- 不是“每个英文段落下面放一段中文翻译”。
- 不是“鼠标悬停或点击后才翻译”。
- 不是“只要有词汇高亮和词典弹窗就算满足”。
- 不是“插件架构相似就算功能命中”。

## 第一层：真正命中核心体验

### 1. Jinshu

产品资料：

- [Jinshu 官网](https://jinshu.built4.fun/)
- [Jinshu 使用文档](https://jinshu.built4.fun/docs)
- [Jinshu 中文文档](https://jinshu.built4.fun/docs-zh)

需求命中：

- 自动按 CEFR 与用户设置筛选需要帮助的英文词。
- 支持词上 ruby、行内括号、点击揭示三种显示方式；前两种符合“生词旁自动给中文”。
- 可把词标为 Known 或 Ignore，之后隐藏对应内联注释。
- 有生词本、上下文句子、间隔复习和 Anki 导出。
- 直接导入 EPUB、文本型 PDF、Markdown 和网页链接。
- 本地优先，离线阅读可用。

关键边界：

- 仅 iOS 和 Android，没有 Windows 桌面版。
- Markdown 是导入后在 Jinshu 内阅读，不是原文件上的实时插件。
- 自动初筛主要来自 CEFR 等级；个人 Known/Ignore 会进一步修正，但它不等于完整的 LingQ 五级模型。
- 官网和文档属于产品自述；产品较新，长期稳定性和大文件表现仍需实测。
- 自动多词短语标注未得到充分证实。

判断：

- **现阶段功能匹配第一名。**
- 如果手机、平板或 Android 墨水屏可承担一部分长文阅读，它是最值得先做 canary 的成品。
- 如果阅读必须发生在 Windows 笔记软件内，它更适合作为体验标杆，而不是最终宿主。

### 2. Laesi

产品资料：

- [Laesi 官网与交互演示](https://laesi.com/)
- [Laesi 功能说明](https://laesi.com/features/)
- [Laesi 使用方法](https://laesi.com/how-to-use/)

需求命中：

- Interlinear Reader 的官方说明是：对每个尚未标记为 Known 的词，在原词下显示 gloss。
- 词汇状态是 Seen → Recognized → Remembered → Known；随着学习，页面逐渐清空。
- 支持多词 lemma，可把短语动词、习语和搭配保存成一个词汇项。
- 支持 EPUB、MOBI、AZW3、FB2、DOCX、TXT 及字幕。
- Windows、macOS、Linux 原生应用，数据和阅读进度保存在本机 SQLite。
- 有 Anki 导出、词汇导入、浏览器扩展和本地多档案。

关键边界：

- 不直接支持 Markdown；需要把 `.md` 转成 TXT、DOCX 或 EPUB，或者未来做导入适配。
- 已确认“未知词下显示 gloss”，但官网没有明确保证默认 English → Chinese 的词典包与释义质量。
- Google Translate 和 AI translate-and-annotate 路径可以产生译注，但必须以实际英文材料做英译中 canary。
- 闭源，价格为 99 美元一次性；无桌面试用版，但官方提供 30 天退款。
- AI 译注采用“生成 prompt → 在外部 LLM 运行 → 粘贴结果”的方式，不是全自动。

判断：

- **Windows 直接使用候选第一名。**
- 不宜在没有样本验证英译中 gloss 前直接判定为最终方案。
- 它证明了“独立本地阅读器 + 共享个人词汇库 + 浏览器扩展”是可行产品架构，不必执着于某个笔记软件的插件。

### 3. WordWise

代码与资料：

- [WordWise GitHub](https://github.com/breeze-r/wordwise)

需求命中：

- 自动检测网页中的不熟悉英文词。
- 直接在原文流中加入简短中文释义。
- 常见或已会词保持不变。
- 用户可以加入生词本或标记“认识”。
- 有 New / Learning / Mastered 等词汇统计与间隔复习。
- 纯前端 Chrome Manifest V3 架构，状态存于 IndexedDB。
- MIT 许可证，可作为二次开发基座。

架构价值：

- `content.js`：扫描文本节点、识别词、插入内联注释、处理点击详情。
- `background.js`：协调词典、LLM、阅读服务和消息。
- 本地词典 + LLM 回退：常见词无 API 成本，复杂上下文再调用模型。
- IndexedDB：保存词汇画像与阅读历史。
- PDF.js 离屏文档：提供 PDF 文本抽取思路。

关键边界：

- 项目非常新，提交数、用户量和发布体系都很小，不能当成成熟成品。
- README、历史后端目录与当前“纯前端”架构并存，代码文档有演化痕迹，移植前必须以当前代码为准。
- 当前主要作用于浏览器 DOM；对本地 Markdown 需要单独渲染器或宿主适配。
- PDF 能力的官方说明偏向摘要文本抽取，不能未经实测就当作完整 PDF 生词阅读器。
- 自动短语识别不充分。

判断：

- **开源拼装的首选核心，不是当前成品首选。**
- 如果最终确定 Obsidian、Logseq 或其他本地笔记软件，可保留其词汇判定、内联注释、状态存储和词典层，只重写宿主适配与渲染层。

## 第二层：命中显示机制，但学习闭环不完整

### 4. Kindle Word Wise + WordDumb

资料：

- [Kindle Word Wise 官方说明](https://www.amazon.com/gp/help/customer/display.html?nodeId=201733850)
- [WordDumb GitHub](https://github.com/xxyzz/WordDumb)
- [WordDumb 文档](https://xxyzz.github.io/WordDumb/)
- [WordDumb 使用说明](https://xxyzz.github.io/WordDumb/usage.html)

命中的部分：

- Word Wise 会自动在困难词上方显示简短释义，提示密度可用滑杆调整。
- WordDumb 能为 EPUB、KFX、AZW3、MOBI 批量生成 Word Wise 注释。
- 支持中文 gloss。
- 可自定义难度和释义。
- 可从 Anki、Kindle Vocabulary Builder、CSV 导入难度，再导出到 Anki。
- WordDumb 是 GPLv3+，项目历史和提交量明显高于 WordWise。

缺口：

- 核心工作流是“预处理电子书”，不是笔记软件里的动态 Markdown。
- Kindle 原生 Word Wise 更接近固定难度阈值，不是完整个人 Known/Learning 模型。
- WordDumb 虽能导入个人难度，但反馈闭环依赖 Anki、Vocabulary Builder 或 CSV，不如 LingQ 连续。

可复用部分：

- Markdown → EPUB → 注释电子书，可作为无开发过渡路线。
- 词偏移定位、难度层级、中文短释义数据库、批量处理和 Anki 互通值得借鉴。

### 5. KOReader wordwise.koplugin

资料：

- [wordwise.koplugin GitHub](https://github.com/asxelot/wordwise.koplugin)

命中的部分：

- 不改原电子书，在当前页上绘制逐页 overlay。
- 在困难词上方显示短释义。
- 可设置 1–5 级提示密度。
- 支持自定义 SQLite 词典和词形回退。

缺口：

- 默认不是 LingQ 式个人词汇状态系统。
- 主要面向 KOReader 电子书环境。
- 仓库没有看到明确许可证；可以学习行为和接口，但在许可证澄清前不能直接复制代码。
- 默认词典以英文解释为主；中文要自己提供数据库。

可复用部分：

- “源文件不改写、阅读时覆盖层渲染”的架构非常适合未来宿主插件。
- 页面坐标、排版碰撞、注释密度和缓存是其主要参考价值。

## 第三层：词汇画像或本地阅读架构可用，但不满足自动内联中文

这些工具不能作为当前需求的直接答案，但可拆出模块：

### Lector

- [Lector GitHub](https://github.com/heuwels/lector)
- 自托管，支持 EPUB 和 Markdown。
- 有词汇状态、SRS、Anki 双向复习与本地 SQLite。
- 主要交互仍是点击查词，不会自动在未知词旁显示中文。
- AGPLv3；直接复制代码会影响最终项目的许可策略。
- 适合参考 Markdown 阅读器、词汇模型、Anki 同步和本地数据库。

### WordByWord

- [WordByWord](https://wordbyword.io/en)
- 可在网页、PDF 和 YouTube 上预先标出未知词，词汇状态从 unknown 到 mastered。
- 翻译主要在点击或悬停后出现，不符合“自动旁注”。
- 适合参考跨内容源词汇画像和阅读统计。

### VocabTracker

- [VocabTracker 帮助](https://www.vocabtracker.com/help.html)
- 受 LingQ、LWT、Readlang 启发；支持网页和 PDF/Word/TXT 导入。
- 支持 lemma 与多级词汇状态。
- 中文释义仍以点击或选择为主。

### Readeri

- [Readeri](https://readeri.com/)
- 支持 EPUB、PDF、FB2、TXT、RTF、HTML、DOCX、Markdown。
- 有 11 级掌握度、词汇训练和统计。
- 翻译以点按为主；而且是云端阅读器，不是本地笔记集成。

### Readlang

- [Readlang](https://readlang.com/features)
- 支持网页、TXT、EPUB；点击后在原位置显示翻译，并自动进入卡片复习。
- 它主要记录用户点过的词，不会事先自动给个人未知词加中文。

### Migaku

- [Migaku](https://migaku.com/)
- Unknown、Learning、Known、Ignored、Tracking 五种状态，SRS 会改变状态。
- 主要是点击查词和制卡，不是自动内联中文。
- 闭源，适合参考词汇状态机和媒体学习闭环。

### WordHunter

- [WordHunter GitHub](https://github.com/Ironship/WordHunter)
- 本地优先的 Tauri 应用，支持 PDF、EPUB、文本、字幕和 URL。
- 有词汇状态、SRS、OCR 和本地数据。
- 不满足自动内联中文，但适合参考跨格式桌面壳与本地数据层。

### Lute、asbplayer、Yomitan

- [Lute](https://github.com/LuteOrg/lute-v3)：MIT，本地阅读、词汇状态和语料库管理。
- [asbplayer](https://github.com/killergerbah/asbplayer)：MIT，擅长把 Anki/WaniKani/本地词汇状态映射成页面样式。
- [Yomitan](https://github.com/yomidevs/yomitan)：GPLv3，成熟的浏览器取词、词典与 Anki 集成。
- 三者都不是直接答案，但分别覆盖本地词汇数据库、状态同步、词典与制卡模块。

## 架构分解：如果最终需要自研，应该拼什么

### A. 内容接入层

优先复用：

- Markdown：使用最终宿主已有的 Markdown AST/阅读视图，不修改源文本。
- PDF：参考 PDF.js 文本层；扫描 PDF 另设 OCR 路径，不混入首版。
- EPUB：参考 Lector、WordDumb 或成熟 EPUB 解析库。

原则：

- 优先保持源文件干净；用户已经允许首版直接写入，因此若宿主 API 不足，也可采用带明确边界、可逆标记和备份的写入路线。
- 注释必须可重建；派生视图不改正文，直接写入路线则使用可识别、可撤销的标记。
- 阅读位置与词汇状态独立保存，避免文件改动导致状态丢失。

### B. 词汇画像层

优先复用：

- WordWise：本地词汇状态、阅读暴露和 SRS。
- Lector：Markdown/EPUB 词汇状态与 Anki 回流。
- Laesi：Seen → Recognized → Remembered → Known 的产品行为。
- asbplayer：外部复习状态如何映射回阅读样式。

最低数据模型：

- lemma 与 surface form。
- status：unknown / learning / known / ignored。
- 首次出现、最近出现、出现次数。
- 用户明确标记与系统推断分开。
- 来源文档与上下文句子。
- 中文短释义及其来源、置信度和人工修正。

### C. 生词判定层

建议采用三段式，而不是只用 CEFR：

1. 初始层：频率、CEFR、用户自报水平，快速建立先验。
2. 明确层：用户 Known / Learning / Ignore 覆盖所有模型判断。
3. 自适应层：阅读暴露、查词、复习、撤销 Known 等行为持续更新。

重要边界：

- “看过多次”不等于“会了”。
- 自动升级 Known 应保守；系统可降低提示强度，但不应悄悄删除用户学习项。
- 短语状态和单词状态必须分开，避免 `take` 已会就漏掉 `take for granted`。

### D. 译注层

建议组合：

- 高频常见义：本地英汉词典，低延迟、零调用成本。
- 多义词和短语：结合所在句子做上下文消歧。
- 中文只显示最短可理解 gloss；完整义项放在点击后的详情面板。
- 用户更换一次义项后，同一篇或相似上下文复用选择。

可借鉴：

- WordWise 的本地词典 + LLM 回退。
- WordDumb 的短释义数据库。
- Laesi 的 lemma、multi-word lemma 与 translate-and-annotate。

### E. 呈现层

至少提供：

- ruby：中文在英文上方。
- under-gloss：中文在英文下方。
- inline parentheses：英文后紧跟中文括号。
- 注释密度滑杆。
- Known 后立即消失。
- 一键临时显示全部困难词，退出后恢复个人模式。

参考：

- Jinshu 的三种显示模式。
- Laesi 的 Interlinear Reader。
- KOReader 的逐页 overlay。
- WordWise 的 DOM 内联标注。

### F. 宿主适配层

只有用户最终选定软件后才写：

- Obsidian：阅读视图/Live Preview 的装饰或 Markdown post processor。
- Logseq：块渲染与页面事件。
- 其他软件：只要能提供文档文本、位置映射和装饰 API，就做薄适配。
- 如果宿主 API 不够稳定，则做独立本地阅读器或生成并排 HTML 视图。

不需要先开发“大型通用插件”。核心引擎保持宿主无关，首个适配器只服务最终选定的软件。

## 跟随选中：单独的架构参考

这一项不应与 Relingo 式未知词旁注混在一起评分。目前找到的是对齐机制参考，而不是与核心功能合一的成品：

- [Libera: Parallel Text Reader](https://apps.apple.com/ca/app/libera-parallel-text-reader/id943767191)
  - 点击一侧的词或短语，会同步高亮另一侧对应片段。
  - 证明了词/短语级 alignment ID 驱动的双向联动体验已经有成品实现。
  - 它使用预先对齐的平行文本，不是任意 Markdown 自动翻译后的通用选择映射。
- [Operaide Translator](https://operaide.ai/showcase/translator)
  - PDF.js 提取带位置的片段，逐段翻译，原文与译文并排显示并同步高亮。
  - 适合参考 sentence/snippet ID、位置元数据和双视图事件同步。
  - 它是整篇翻译工具，不满足未知词旁注核心需求。

如果未来恢复这一需求，最稳的实现不是监听两个视图的原生 selection 文本去猜对应关系，而是在生成译注时保存稳定的 `source span ↔ gloss span` 或 `segment id` 映射；选择任一侧后，通过映射给另一侧添加视觉选区。

## 当前推荐

### 立即可用路线

1. **优先验证 Jinshu**
   - 用一篇真实 Markdown 长文。
   - 检查自动中文旁注密度、Known 后是否即时消失、跨文档是否保持。
   - 如果移动端阅读能覆盖相当比例，它可能直接解决主要问题。

2. **Windows 侧验证 Laesi**
   - 将同一 Markdown 无损转成 TXT 或 EPUB。
   - 重点看 English → Chinese gloss 是否稳定、是否够短、是否能正确处理多义词。
   - 官方无试用但有 30 天退款；在测试结果出来前不建议直接锁定。

3. **需要电子书批处理时验证 WordDumb**
   - Markdown → EPUB → WordDumb 中文 Word Wise。
   - 这是可逆的过渡路线，不改变原 Markdown。

### 如果最终必须留在笔记软件内

采用小型拼装方案：

- WordWise MIT：词汇判定、中文内联、状态与 SRS 核心。
- 最终笔记软件：只写一个薄渲染适配器。
- Lector / asbplayer：参考 Markdown、本地状态和 Anki 回流。
- WordDumb：参考离线中文 gloss 与批处理。
- KOReader：参考不改源文的 overlay。

首版不做：

- 多语言。
- 任意本地软件通用嵌入。
- 扫描 PDF OCR。
- 全自动高精度短语挖掘。
- 双语段落翻译。
- 同步选中，除非它成为当前阅读的实际阻塞。

## 尚未解决的真实风险

- **短语自动识别**：现成实现大多以单词为中心；Laesi 支持手动保存多词 lemma，但自动短语旁注仍未确认。
- **中文释义质量**：Jinshu 和 WordWise 明确面向中文注释；Laesi 的英文→中文实际效果需要 canary。
- **成熟度**：Jinshu 和 WordWise 都较新，不能只凭官网或 README 判定长期可靠。
- **Markdown 往返**：现成产品多数“导入副本阅读”，不在原笔记视图实时显示。
- **直接写入边界**：用户允许首版写入原文，但必须避免中文注释进入代码、URL、frontmatter、标题锚点和链接目标；写入结果必须可重建、可撤销。
- **许可证**：WordWise 是 MIT；WordDumb、Yomitan 是 GPL；Lector 是 AGPL；KOReader 插件许可证未明确。拼装时必须保持实现边界。
- **推断不等于掌握**：系统根据频率或暴露次数推断“会”必须可撤销，并与用户明确 Known 分开。

## 决策阅读顺序

1. 先看 [Jinshu 中文文档](https://jinshu.built4.fun/docs-zh)：确认“Markdown + 自动旁注 + Known/Ignore”的成品体验。
2. 再看 [Laesi 首页的 Interlinear Reader](https://laesi.com/)：确认 Windows 本地产品如何把个人词汇状态直接映射到 gloss。
3. 再看 [WordWise GitHub](https://github.com/breeze-r/wordwise)：确认核心功能已经有 MIT 开源实现，并查看其模块边界。
4. 再看 [WordDumb 文档](https://xxyzz.github.io/WordDumb/)：理解批量电子书注释、中文 Word Wise 与 Anki 难度导入。
5. 最后看 [Lector](https://github.com/heuwels/lector) 与 [KOReader Word Wise 插件](https://github.com/asxelot/wordwise.koplugin)：分别补齐本地 Markdown/学习状态与覆盖层渲染的架构参考。

## 最终判断

- **要最快得到接近 Relingo 的本地文件阅读体验**：先测 Jinshu；Windows 必须时再测 Laesi。
- **要最终嵌入选定笔记软件**：以 WordWise 为核心参考，写薄适配器，不从零开发完整系统。
- **要零代码临时过渡**：Markdown 转 EPUB，再走 Jinshu 或 WordDumb/Kindle/KOReader。
- **当前不应继续做的事**：继续在 Obsidian/Logseq 插件市场里寻找“沉浸式翻译式双语段落插件”，因为那不是目标交互。
