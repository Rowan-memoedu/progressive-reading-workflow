# 渐进阅读｜标准 Markdown 前置处理接口 v1

合同版本：`1.0.0`；可调用接口版本：`1.3.0`；处理器：`1.12.0`

## 边界

接口只替代各来源工程中的这一段：

```text
原始 Markdown + 来源元数据
  -> 标准前置处理接口
  -> 最终阅读 Markdown / 隔离 Markdown + 结构化 artifacts + receipt
```

网络内容导入和浏览器采集继续负责获得原始 Markdown 与来源元数据。它们的现有 canary 不等待本接口；接口稳定后以增量方式替换各自的“原始 Markdown → 最终标准阅读 Markdown”处理步骤。

不属于本接口的事项：抓取网络内容、操作 Chrome/浏览器、Local IR UI/阅读状态/高亮/侧栏、RemNote/Logseq 写入，以及直接修改两个来源任务。

## 日常导读的覆盖模式

标准工作流最终的导读阶段只使用 Codex Exec，统一采用 `guide-coverage/v2` 与 `guide-fidelity/v1`。先从原文建立并冻结带证据和观点身份的信息点，再分段提取、整篇删重、核对观点保真与覆盖、局部修正和补漏；各阶段均携带全文语境。引文、反方主张、依据、例子、数字、条件及解释性脚注均在范围内，保留原文判断力度，不添加原文没有的免责声明或平衡意见；整篇不受单次 24 条预算限制。失败卡片不能作为警告放行，也不触发正文重写。覆盖与保真结果分别写入 `reading_guide_coverage`、`reading_guide_fidelity` 核验项及调用用量审计，不混入正文。网页、视频、PDF、EPUB、TXT、RSS 等标准导入均共用此入口。

覆盖版本仅使导读缓存失效；已完成的正文和翻译阶段继续复用。关闭导读时不调用此过程，旧 API 兼容路径保持原行为。阶段记录默认位于 `D:/AppData/ProgressiveReading/guide-coverage`，进程变量 `PR_GUIDE_COVERAGE_CACHE_DIR` 可指定其他位置。覆盖未通过时保留失败现场，缺失的所选导读不得冒充完成或发布。

## 可调用入口

本地正式入口是安装到 PATH 的 `pr-preprocess`，无需启动常驻服务：

```powershell
pr-preprocess --json doctor
pr-preprocess --json validate --request request.json
pr-preprocess --json run --request request.json --output .\imports\preprocess-runs\<source>\<material-id> --publish ".\阅读区\<source>\<title>.md" --strict
```

Node 来源工程可从 `web-markdown-import-workflow/preprocess` 导入 `buildPreprocessRequest`、`standardWorkflowOptions` 和 `runPreprocessingRequest`。`standardMarkdownOptions`、`spokenMarkdownOptions`、`sourceTranslationOptions`、`mathLectureTranslationOptions` 与 `mathLectureStandardizationOptions` 是兼容的单阶段入口。CLI 与 JS API 调用同一处理器、Schema、prompt、缓存和确定性渲染器，不存在两套内容标准。

`validate` 和 `run --dry-run` 不调用外部 AI。正式 `run` 默认使用 `%USERPROFILE%\.pr-preprocess\cache` 作为跨来源共享幂等缓存。`--output` 是审计运行目录，应放在 `imports/preprocess-runs/...`；其中 `result.json` 通过结果 Schema 后最后原子提交，是处理调用完成标记，正常结果另含 `request.json`、`run-manifest.json` 和审计副本 `reading.md`，隔离结果改为 `quarantine.md`。

`--publish` 指定阅读区内一个精确的最终 `.md` 文件。发布路径必须是 `阅读区/<来源分类>/<标题>.md` 这类平铺文件，禁止把审计运行目录放在阅读区，也禁止交付 `阅读区/<来源分类>/<材料>/reading.md`。正文引用相对 `assets/...` 图片时必须同时传 `--asset-source <assets-dir>`；发布器把所引用图片复制到同级 `_assets/<标题>/`、改写 Markdown 链接，并在审计目录写入 `publication.json`。目标 Markdown 或图片已存在但哈希不同时，发布失败且不覆盖。

发布层会清除来源解析阶段的 HTML 注释、临时来源锚点和不可见控制字符，并把可映射的内部来源链接改写为 Local IR block 跳转。发布后仍出现 Pandoc fenced div、Pandoc 属性、原始 OOXML 或 replacement character 时返回 `publish_markdown_not_clean`。该规则不删除标准 Markdown 或 Local IR 正文块标识；清理计数写入 `publication.json.cleanliness`。

生产方应为同一材料使用稳定审计目录和稳定发布文件，不按模型重试或人工复核轮次创建 `vNN` 文件夹。模型候选与重试只记入 `receipt.model`；接口只提交最终一份阅读产物，并清理同一审计目录中与最终状态冲突的 `reading.md` / `quarantine.md`。只有明确的开发诊断才允许另存快照，诊断目录不能作为标准产物交付。

`--json` 的成功信封固定以 `{ "ok": true, "command": "..." }` 开头；失败信封固定为 `{ "ok": false, "error": { "code": "...", "message": "...", "details": ... } }`。密钥不进入信封。调用方只有在状态为 `completed` 或合格的 `idempotent_replay`、`processing_state == rendered` 且 `target_zone == local-ir-reading` 时才能发布到正常阅读区；是否完成发布以 `publication.status == published`、最终文件哈希和 `publication.json` 为准。

## 请求

`schema_version` 必须是 `progressive-reading.preprocess.request/v1`。最小请求：

```json
{
  "schema_version": "progressive-reading.preprocess.request/v1",
  "contract_version": "1.0.0",
  "material": {
    "markdown": "# 原始材料\n\n正文……",
    "original_markdown": ""
  },
  "source_type": "web_markdown",
  "source_metadata": {
    "source_url": "https://example.com/article",
    "title": "标题"
  },
  "user_instruction": "保留术语和代码块。"
}
```

`material` 可以直接是 Markdown 字符串，也可以用顶层 `input` 字符串兼容最小调用方。译文在找到原文后，可把原文正文放入 `material.original_markdown`。

新调用使用 `processing_options.workflow_mode: standard` 或 `standardWorkflowOptions()`。原始最小 JSON 未声明工作流时仍兼容旧单阶段接口。标准工作流如下：

1. 接收 `spoken_to_written`、`structure_body`、`translate`、`include_reading_guide` 的部分或全部布尔值；未指定项按可信类型生成默认值。显式 `false` 不会被默认值覆盖。
2. 只对影响剩余选择的缺失分类调用 `workflow-router-v1.3-demand-driven`。已知字段不要求模型重复返回；低置信度或明确未知立即返回 `needs_classification`。格式错误保留有限重试。
3. `natural_language` 默认生成导读；`math_lecture` 和 `literature` 默认关闭；显式 `true / false` 优先。全部选择已明确时不调用分类模型。
4. 执行必要的口述整理、显式结构整理和翻译。书面 Markdown 默认本地规范化；未显式指定翻译时仅英文进入翻译，已双语不重复翻译。
5. 翻译后附原文。导读开启时只根据最终正文生产一次导读阶段；关闭时跳过该阶段，语义判断为 `null`、洞察为 `[]`。校验拒绝“生成后隐藏”。

`receipt.workflow_route.plan` 保存最终选项，`classifier` 保存实际分类调用；`stages` 保存阶段、输入/正文哈希和缓存命中。正文、翻译和导读独立缓存；导读失败或开关变化不会重做成功的正文步骤。`receipt.reading_guide` 保存 `skipped / generated / failed`、原因及当次调用数。缓存重放的模型调用数为零。完整默认表、JSON 示例和各入口恢复方式见[处理方案](../standard-preprocessing/docs/processing-plan.md)。

重要来源字段：

- `source_url`：本次材料的来源页。
- `original_url`：译文对应原文的可验证链接。
- `source_is_original`：当前来源本身就是原作时设为 `true`，避免把同一来源误判成缺原文链接。
- `translation.is_translation`：调用方已知它是译文时设为 `true`。
- `translation.original_language` / `translation.translation_language`：语言提示，不决定材料身份。

调用方可以显式传 `material_id` 和 `idempotency_key`；省略时由接口确定性派生。

## 结果

`schema_version` 为 `progressive-reading.preprocess.result/v1`。稳定顶层字段：

- `status`
- `material_id`
- `idempotency_key`
- `processing_state`
- `translation_state`
- `artifacts`
- `source_metadata`
- `receipt`
- `errors`

`status`：

- `needs_classification`：等待补充分类或显式处理选择；`artifacts` 为空，不发布。缺项见 `receipt.workflow_route.missing_labels`。CLI 退出码为 `3`；补充同一请求后续跑。

- `completed`：通过校验，可进入正常阅读池。
- `completed_with_warnings`：可供审计的正文含有警告。只有所选译文、导读均实际生成时，发布器才能把可读警告放行；原文回退或缺失导读不进入阅读区。
- `quarantined`：译文缺少原文链接，只能进入隔离区。
- `failed`：请求本身不满足合同，未产出可用正文。
- `idempotent_replay`：相同幂等键已处理，返回缓存产物。

`translation_state`：

- `not_translation`
- `translation_original_missing`
- `alignment_pending`
- `aligned`
- `generated_translation`
- `unknown`

`artifacts` 的关键内容：

- `reading_markdown`：可写入 Local IR 阅读区的最终 Markdown；隔离时为 `null`。
- `quarantine_markdown`：缺原文链接译文的隔离文件；正常时为 `null`。
- `target_zone`：`local-ir-reading` 或 `translation-quarantine`。
- `semantic`：三个置顶判断与动态核心洞察。
- `body_blocks`：真实正文块、稳定 `source_block_key`、确定性 `block_id` 和内容哈希。
- `cleaning_manifest`：逐源 block 的唯一处理状态、原因、原句和正文去向；结构化原句只留在 artifacts 的审计附录，不混入最终阅读正文。
- `bilingual`：检测事实、原译文对应、置信度和状态。
- `artifact_hashes`：最终 Markdown、semantic 和正文块的 SHA-256。

## 阅读 Markdown 合同

阅读前置卡依次置顶：

1. 价值判断：`高 / 中 / 低 / 跳过`。
2. 信息密度判断：`高 / 中 / 低`。
3. 是否继续阅读：`0–4`，共五档：`0 不值得读`、`1 一句话核心`、`2 概览与关键结论`、`3 全文`、`4 精细阅读`。原八档中的“概览”“选择性全文”“精细阅读并加工”已删除，其余档位按顺序重新编号。

之后是 `核心洞察`。每条使用中文序号呈现 `标题：描述`，下一行呈现 `[[#^block-id|正文跳转]]`，条目之间保留空行。描述须非空，数量和长度由内容决定；不设 60 字等最低字数，不因文风、术语保留或洞察数量触发生产重试。跳转仍须引用真实正文块。

正文跳转来自 `target_block_key -> 本地 block_id` 映射。模型只返回已有 `source_block_key`；校验器拒绝不存在的目标，本地渲染器在对应洞察的下一行生成 `[[#^block-id|正文跳转]]`。渲染器先为全部正文块生成稳定 block id，最后由确定性收尾脚本只保留前置卡实际引用的真实 `^block-id`；未被引用的可见锚点会删除，但 block id、来源映射和哈希仍保存在结构化 artifacts 中。

## 整篇清洗与双语规则

已确认的“双语标准处理”含义是整篇清洗，不是把接口缩窄成纯段落对齐器：

- 标准工作流先完成必要的口语转书面，再分类、按 profile 翻译，最后按同一 profile 标准化；英文自然语言与英文数理 Lecture 都把原文置于译文之后。
- `math_lecture` 先通过独立术语盘点提示识别当前材料中的定义项、命名算法、数据结构、数学/CS 概念、人名、缩写与原文标签。术语必须逐字来自当前材料；没有明确批准译名或拿不准时保留英文原文，不用单一样本词表、机械字符串替换或事后手改产物。
- 对应关系是质量步骤；不能可靠对齐时写 `uncertain` 或 `pending`。
- 对应项保留 `original_block_key`、`translation_block_key`、`confidence`、`status`。
- 已知译文缺 `original_url` 时，接口不调用外部 AI，直接返回隔离产物。
- 找到原文后补充 `original_url`，最好同时注入 `original_markdown`。只要译文主正文和来源身份未变，`material_id` 保持不变；因为处理条件变化，`idempotency_key` 会变化。

## 受监督 AI 与失败降级

模型输出必须通过以下本地校验：

- `semantic_only` 模式只返回判断、洞察和双语对应，不回显正文；这是调用方已完成正文清洗时的安全路径。
- 默认 `source_voice_structuring` 模式执行整篇来源保真清洗，只允许通过稀疏 block 补丁修复断句、机械重复、段落与内容型标题，不得总结、扩写、转述或改变原视角。
- `cleaned_blocks` 使用稀疏补丁：只返回真正修改的 block，key 必须存在、不重复且保持输入顺序；未返回的 block 由本地按原文确定性补回。
- `lossless_spoken_to_written` 使用版本化的[通用清洗合同](../standard-preprocessing/prompts/lossless-spoken-to-written-v1.md)。模型必须用 `cleaned_sections` 覆盖每个 source key 恰好一次，只合并相邻块，把问答、插话和字幕碎片变成连贯书面章节，并保留全部实质信息。
- 口语转书面模式校验覆盖顺序、实质信息与章节保真。口语噪声、标题和问答外观只记录为编辑建议，不为这些风格指标追加模型调用。
- 代码块、伪代码、LaTeX 和行内代码保持不变。
- 正文相似度不能低于保真阈值，原始 URL 不能被删除。
- 三个判断枚举合法，继续阅读等级是 `0–4` 整数。
- 洞察标题与描述非空，不按字数、数量或措辞评分；全部指向真实正文 block key。
- 双语对应引用的 key、置信度和状态合法。

传给外部模型的 `source_metadata` 使用白名单，只含来源链接、标题、作者、时间、语言、翻译标记和最小 capture 证据。Cookie、Authorization、Headers、Token 及其他任意扩展字段不会进入模型请求；本地 `result.json` 仍保留调用方提供的来源元数据用于追溯。

传输或结构错误由失败阶段进行有限重试，整条工作流只调用一次，成功阶段独立缓存。重试耗尽时内部保留原文和错误，`translation_state` 不得伪称 `generated_translation`；缺少所要求的译文或导读时停止正式发布。`errors`、阶段目录与 `receipt.model.attempts` 保存原因，不写入阅读正文。

## 幂等与恢复

自动 `material_id` 由 `source_type + 来源身份 + 译文/主正文哈希` 派生，不包含后来注入的原文正文或 `original_url`。自动 `idempotency_key` 还包含：

- 主正文哈希
- 注入原文哈希
- 规范化来源元数据
- 用户补充指令
- processing options
- 合同版本
- processor 版本和 prompt 版本

因此，相同条件重复调用会 replay；给隔离译文补原文会以同一材料身份发起新的处理版本。

## 合成 canary

`npm run preprocess:canary` 覆盖四条路径：单语正常、双语对齐、缺原文隔离、注入原文恢复。它不调用外部 AI。`npm run preprocess:canary:live` 使用同一组合成材料调用已配置的低成本 API，验证真实模型输出、校验与重试。两者的产物和压缩回执都在 `standard-preprocessing/canary/artifacts/`，均不读取私人材料。

两份 JSON Schema 不是说明性占位：`npm run preprocess:test` 会实际编译它们，并校验四种 fixture 请求及其离线结果。结果 Schema 对正常阅读、隔离和失败状态做条件约束，并具体约束 `artifacts`、`source_metadata`、`receipt` 与 `errors` 的稳定字段。
