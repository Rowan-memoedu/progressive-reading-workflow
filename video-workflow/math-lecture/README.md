# 数理视频与板书转讲义

输入为一组明确的视频分 P、完整字幕和配套板书/讲义。输出一份嵌套 Markdown lecture，逐步保留公式、理由、条件、例题和不同方法；不生成导读卡，不把推导继续藏在截图里。点名、轴名等必要图内标注可以保留。明确的源数学笔误最小修正，学习正文不显示校订痕迹。

多分 P 的长课也可以让每个输入清单只含一个 P，分别准备、运行和交付。特别长的单 P 可在 `assemble` 时加 `--split-chapters`，按已审核目录输出独立章节文件；完整例题和推导单元不被切开。每个文件分别核对来源、哈希与渲染，整 P 的合成稿仅作整合审核底稿。已选择的章节交付模式在后续续跑时保持。

字幕获取复用既有 `prepareWatchSource`；来源获取不运行视频图文生产、截图、导读或旧后台队列。PDF 解析复用已有 MinerU；已完成解析按原始文件身份直接复用。图文生成与独立审核使用现有 `standard-preprocessing/batch_transport.py` 和官方 Codex Exec，不建立常驻服务、调度器或新凭据路线。

B 站元数据、分 P 列表和字幕默认使用现有用户登录快照；登录态不可用时明确失败，不退回匿名访问，不新建凭据路线。凭据只发送给对应的 B 站接口，不进入资料清单、模型上下文或输出。

函数曲线、水平线交点等几何关系无法由分类流程图完整表达时，复用 `MathTopicPipeline/diagrams` 的参数化科学绘图能力。`reconstruct-diagram.mjs --source-image ... --source-id ... --plan ... --output ...` 校验原图身份、数值约束、曲线特殊点并生成独立 PNG/SVG。绘图计划保留原图哈希，不修改原始像素或讲义候选。通过运行目录的 `diagram-reconstructions.json` 注册 `{ "images": [{ "source_image_id": "img0000", "receipt": "绝对回执路径", "receipt_sha256": "回执哈希" }] }`；只有对应单元增加新图输入并重新生成，独立审核同时比较原图与重建图。其他单元保持缓存。依赖路径可用 `MATH_LECTURE_DIAGRAMS_ROOT` 指定。

## 输入准备

```powershell
node video-workflow/math-lecture/acquire.mjs --url '<视频链接>' --parts '3-8' --board '<板书PDF>' --output '<D盘产物目录>/source-inventory.json'
```

平台没有字幕时，可显式加 `--asr-if-needed true`。此时只下载所选分 P 的音轨，通过现有全局转写 CLI 的当前默认后端取得带时间戳的字幕；校验分 P 身份、音频与结果哈希、时间戳及云端暂存清理。不会静默切换服务。原有本地视频适配器要求视频轨，这里只补音频入口，复用其字幕解析和完整性校验。依赖现有 `BaiduVideoNotes/lib/local-source.cjs`（可用 `MATH_LECTURE_LOCAL_SOURCE_MODULE` 指定其路径），不复制实现。

运行现有 MinerU OCR 入口，保留 `*_content_list.json`、Markdown 和图片。用已有 PDF 渲染工具把对应 PDF 页渲染为图片；手写公式存在具体识别问题时，模型接收对应页面的实际像素。这里使用板书页，不回看视频截图。已有文字讲义可通过同一结构解析入口提供。

只使用讲义的一部分时，`prepare` 加 `--board-pages '3-13'`。若 MinerU 的页码从选中页重新按零编号，还需加 `--relative-ocr-pages`；渲染文件模板仍使用原 PDF 的物理页码。缺页会失败，不能把部分解析误记为整本已覆盖。

可用 `--ocr-pages` 指定该 OCR 批次对应的原 PDF 页码，再用 `--board-pages` 选较小的实际授课范围。末页只有部分例题属于本课时，用 `--board-blocks` 明确选择原 OCR 中的零起始块下标；所选内容和原文件哈希均留档，不修改 OCR 原件。

```powershell
python video-workflow/math-lecture/pipeline.py prepare --inventory '<来源清单>' --board-content '<MinerU content_list.json>' --page-template '<页面目录>/board-{page:02d}.png' --output '<D盘产物目录>/run'
python video-workflow/math-lecture/pipeline.py plan --output '<D盘产物目录>/run'
python video-workflow/math-lecture/pipeline.py run --output '<D盘产物目录>/run' --workers 2
python video-workflow/math-lecture/pipeline.py assemble --output '<D盘产物目录>/run'
python video-workflow/math-lecture/pipeline.py verify --output '<D盘产物目录>/run'
```

`prepare` 冻结来源身份；`plan` 按主题分章、按完整推导或例题拆单元，并精确验证字幕与板书块的无遗漏、无重复分配。每单元依次生成强结构化大纲、lecture，再用原始来源与实图独立审核。图像先按纯示意图与含公式混合图分类；只有纯示意图可直接进入正文，混合图内容转成 LaTeX、自然语言及适合的 Mermaid。已确认保留的纯示意图必须实际嵌入正文；混合图中独立的示意关系也不能消失为纯文字。

OCR 把相邻例题合成同一文本块时，来源对齐可用原文唯一引句标记切分；程序计算字符范围并保留原块身份，每个字符恰好分配一次，不重做 OCR、不凭模型计算偏移。对齐审核失败只重试板书归属，已完成的字幕分段和其他分 P 保持缓存。

## 局部恢复

每次 `run` 先回读已通过单元的来源、正文和审核哈希；输入未变且已通过的单元直接复用，即使为了失败样本澄清了通用生成提示词也不重跑。失败单元不妨碍其他单元继续。调用原始响应保留，缓存身份包含提示词、来源、实际图片、后端和模型；不能手改候选来制造通过。

单元在独立语义审核前先用与最终渲染相同版本的严格 KaTeX 检查公式语法；中文标点、未闭合分段环境等格式错误也进入局部重生成。此前接受的正文只在这项检查确认失败时重新生成，语法正常的单元继续复用。KaTeX 默认复用既有渲染资源缓存，可用 `PR_KATEX_LIBRARY` 指定同版 UMD 文件；缺少运行时会明确失败。

独立审核未通过时，默认最多从原始来源重新生成该单元两次（`--revisions 0` 可关闭）。审核意见仅作待核查线索，不能覆盖来源。强结构化结果、每轮候选和审核均保留并缓存；重试不重新解析 PDF、不重取字幕、不重生成已通过单元。超过次数后保留失败状态，等待通用流程修订。

出现具体手写/OCR 识别问题时，加 `--verify-board-transcription`，先对受影响单元核对实际图中的书写与页边条件，再生成大纲。已通过单元保持复用。每份候选还经过单独的数学内部一致性审核，逐题将取等数值代回条件和目标，检查代数、符号与定义域；这与来源完整性审核分开缓存。

生成与审核默认使用共用 Codex Exec 入口的 `gpt-6.1-sol`。`--model` 仅为本次运行显式选择模型，不修改全局配置；省略时沿用共用默认值。模型身份进入缓存及审核记录。需要更换数学审核模型时，可加 `--recheck-math`：只重新审核已通过正文，审核通过则保留正文；确认有错误才重新生成受影响单元。

修复通用工作流/提示词后重新运行：未通过单元只执行发生变化的阶段，成功阶段保持缓存。新内容要求若影响先前已通过单元，明确选择范围重新打开：

```powershell
python video-workflow/math-lecture/pipeline.py status --output '<运行目录>'
python video-workflow/math-lecture/pipeline.py run --output '<运行目录>' --units u003,u007 --refresh
```

`--refresh` 必须指定单元，不能隐式重生成整份。整合审核只定位受影响单元；整合失败不会删除局部结果。最终讲义已被用户修改时拒绝覆盖。文件锁随进程释放，中断后可以原命令续跑；成功模型响应不会再次请求，传输失败保留尝试记录。

局部重生成会收到整合审核中明确指向该单元的问题，作为回到原始来源核查的线索。需要承接已证明的同一情形时，可在运行目录的 `unit-context.json` 中指定 `{ "units": { "u004": ["u002"] } }`。只允许引用更早且已通过的单元，逐项核对其来源、正文和两类审核哈希；提供已验证的上文，保留新增范围及方法，避免以重复整段推导代替衔接。

如果整合失败来自题设、字幕解答与板书跨单元错配，先运行 `repair-boundaries --output '<运行目录>' --units u003,u004`。它仅在所选单元原有来源总范围内重分配，检查完整覆盖并独立审核；保留旧计划和修订记录，拒绝修改任何未选中单元。随后普通 `run` 只重新生成来源归属发生变化的单元。

同一道题在相邻来源单元中重复完整讲解时，可对整合审核定位的单元运行 `merge-units --output '<运行目录>' --units u003,u004`。仅允许同 P、同章、连续单元，合并来源后从原始输入重新生成，旧单元记录保留。其他单元逐项证明本单元来源、正文与审核未变后，只更新目录依赖绑定，不调用模型重新生成；整合审核负责重新检查全局衔接。

## 验收

```powershell
python -m unittest discover -s video-workflow/math-lecture -p 'test_*.py'
node --test video-workflow/math-lecture/acquire.test.mjs video-workflow/math-lecture/asr-source.test.mjs
```

`verify` 先核对整合正文、来源与所有单元审核哈希，再调用既有 `video-workflow/verify-rendering.py` 检查 Markdown、LaTeX、Mermaid 和图片，并写入 `acceptance.json` 及 HTML 预览。`publication.json` 在渲染前仅声明 `content_accepted_render_pending`，不把内容审核当作完整呈现验收。原始字幕、板书、OCR、候选、审核和验收记录均留在 D 盘产物区，不进入 Git 或 RemNote。
