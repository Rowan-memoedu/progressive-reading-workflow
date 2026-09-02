# 标准 Markdown 前置处理闭环 v1

状态：规范性目标。实现只有满足本文全部强制门，才可声明处理闭环通过。

## 1. 适用范围与边界

本闭环负责把已经获得的原始 Markdown、来源类型、来源元数据和用户补充指令，处理为可进入 Obsidian Local IR 阅读区的标准阅读 Markdown，并同时生成可审计 artifacts、source metadata、receipt 和 errors。

运行时必须是平台中立的确定性 orchestrator，不依赖 Codex Thread、Codex Subagent、浏览器或任何特定交互界面。Codex Subagent 只用于开发期的实现、独立审查和 Canary 隔离，不是接口的运行时依赖。

## 2. 状态机

```text
received
→ normalized
→ translation_gate
  ├─ missing_original → quarantined
  └─ passed
→ cleaning_production
→ local_validation
  ├─ failed → targeted_repair → local_validation
  └─ passed
→ independent_semantic_audit
  ├─ failed → targeted_repair → local_validation → re_audit
  └─ passed
→ document_validation
→ guide_card_production
→ guide_card_validation
→ guide_card_audit
→ deterministic_render
→ final_validation
→ receipt
→ completed
```

任何阶段都不得通过重新运行整个材料来修复局部错误。只有失败阶段及其下游阶段失效；已经通过且 fingerprint 未变化的上游 artifact 必须复用。

## 3. 阶段输入与输出

### 3.1 received → normalized

输入：原始请求。

输出：

- 规范化请求和 source metadata；
- 不可变 source blocks 及其 `source_block_key`；
- `material_id`、内容指纹和运行幂等键；
- 输入正文、原文、用户指令和处理策略的 hashes；
- 双语/译文初步检测结果；
- 确定性 chunk manifest。

本阶段不调用外部模型。

### 3.2 translation_gate

输入：规范化材料、双语检测和来源元数据。

输出：`passed`，或缺原文链接译文的 `quarantined` 结果。

隔离结果必须保留原始材料、恢复条件、`material_id` 和 receipt；不得生成正常阅读区 artifact。

### 3.3 cleaning_production

输入：一个确定性 chunk、清洗合同、用户指令中与正文清洗有关的部分，以及该 chunk 最近一次被拒绝的结构化错误。

输出：只包含该 chunk 的 `cleaned_sections`、完整 source key 映射、清洗理由、候选 hash 和模型 usage。

首次生产可以生成完整候选；后续只能依据错误包定点修复，不得重新摘要整篇或重新生成已经通过的 chunk。

### 3.4 local_validation

输入：原始 chunk、清洗候选和处理策略。

输出：机器可读 verdict，以及精确到 section/source key 的错误项。至少校验：

- source key 覆盖、唯一性、顺序和相邻合并；
- 正文非空、长度比例、标题和问答形态；
- URL、代码、LaTeX、行内代码及其他受保护语法；
- 可见时间码和纯会话噪声；
- 原视角、措辞强度和可计算的保真代理指标。

本阶段不调用模型。错误必须包含稳定 code、stage、source keys、expected 和 actual，不能只返回自然语言说明。

### 3.5 targeted_repair

输入仅包括：被拒绝候选、对应原始 source blocks、结构化错误和适用规则。

输出必须保持原 source keys，只修改错误涉及的 section。修复后必须重新经过本地校验；不得由生产模型自行声明通过。

### 3.6 independent_semantic_audit

输入：通过本地校验的最终清洗候选及对应原始 source blocks。

输出至少包含：

- `verdict: pass|fail`；
- 按 source key 定位的 `missing_points`；
- `added_points`；
- `changed_stance`；
- 审计理由、auditor 标识和调用 usage。

语义审计是每个最终清洗候选的必跑门，不能只在词面相似度失败时触发，也不能采信生产模型写入候选的自证字段。审计必须使用独立调用、审计专用 prompt 和独立响应 schema。若受成本限制而使用同一模型，receipt 必须标记 `role_separated_same_model`，不得表述为模型独立。

任何问答形态归一、段落重写或其他后处理只要改变正文，就必须对受影响 section 重新执行本地校验和语义审计。

### 3.7 document_validation

输入：所有通过 chunk 审计的清洗 sections。

输出：整篇覆盖、整体长度、结构、问答形态、噪声、源角色边界和 section 顺序的 verdict。失败时只生成指向相关 sections 的错误包，不重新生产全部正文。

### 3.8 guide_card_production、validation 与 audit

输入：已经通过正文审计的清洗稿、来源元数据、用户关注点和洞察策略。

输出：三个置顶判断、动态核心洞察、双语对应和 target source keys。

每条洞察必须可脱离标题和跳转独立理解，直接陈述核心内容，不使用“作者认为”“说话者指出”等转述套话。长材料的洞察描述硬下限为 60 个非空白字符，软目标为 60–120 个非空白字符；不为追求长度扩写外部信息。

本地校验负责枚举、数量安全上限、描述长度、归因套话、target key 和双语字段。随后必须以独立调用审计洞察是否遗漏关键条件、加入外部事实或升级原文认知强度。失败时只修复导读层，不重跑正文清洗。

### 3.9 deterministic_render 与 final_validation

输入：全部通过的正文、导读、双语状态和 metadata。

输出：确定性 body block ids、真实正文跳转、最终阅读 Markdown 和 artifact hashes。

模型不得生成或猜测 Obsidian block id。最终校验必须检查所有必跑门、跳转目标、hash、状态与 target zone 一致性。渲染后正文若发生任何变化，必须使原审计失效并重新验证。

### 3.10 receipt

所有终态都必须生成 receipt。receipt 至少记录：

- 合同、处理器、prompt 内容和规则版本；
- 每阶段输入/输出 hash、状态、开始与结束时间；
- 每次模型调用的 stage、provider、model、usage 和 transport 尝试数；
- 本地校验、独立审计、缓存命中和修复次数；
- 调用硬预算、实际消耗、停止原因和最终 target zone。

失败调用也必须计数；不能只统计最终返回成功对象的调用。

## 4. 重试与调用硬预算

重试分为 transport retry 和 content repair，两者必须分别计数。

- HTTP 超时、429 和 5xx：首次调用后最多重试 2 次；不改变 prompt，不计为内容修复。
- 每个清洗 chunk：首次生产后最多 2 次定点修复。
- 清洗审计：最终候选必跑一次；审计失败最多再做 1 次定点修复和 1 次复审，且占用该 chunk 的修复预算。
- 全文问答形态归一：最多 1 次批量定点修复，随后必须本地复验和语义复审；禁止退化为不设上限的逐 section 调用。
- 导读层：首次生产后最多 2 次定点修复，并执行一次独立审计；审计失败后的修复也占用同一预算。
- 禁止在上述预算之外增加“整篇再试三次”等外层重跑。

每个材料必须在生产开始前计算并写入外部调用硬上限。v1 默认建议：

```text
external_call_hard_cap = min(64, max(16, 2 × chunk_count + 14))
```

所有真实 HTTP 尝试都消耗硬预算。预算耗尽立即进入复核终态，保存 checkpoint 和失败包，不再调用模型。超长材料若最低必跑调用已经超过硬上限，应在生产前进入确定性分区或明确拒绝，不能运行到一半静默降级。

## 5. Checkpoint、缓存与幂等

运行目录应保存可原子恢复的阶段状态，例如：

```text
run-state.json
checkpoints/
  normalized.json
  cleaning/chunk-0001.json
  cleaning/chunk-0001.audit.json
  document-validation.json
  guide-card.json
  guide-card.audit.json
  render.json
  receipt.json
```

要求：

- 每个阶段通过后立即以临时文件加原子 rename 落盘；
- 只复用已通过 artifact，拒绝候选仅保存为审计证据；
- 阶段 fingerprint 覆盖阶段名、阶段合同版本、输入 artifact hashes、prompt 文件内容 hash、provider/model 和相关 policy；
- prompt 仅改版本字符串而内容变化，或内容变化而版本不变，都必须导致缓存失效；
- 客户提供的幂等键只作为 `client_idempotency_key`，不得覆盖内容派生的运行键；
- 相同客户键对应不同内容指纹时必须返回碰撞错误；
- 并发处理同一运行键时使用锁或原子占位，避免重复付费与互相覆盖；
- 中断恢复从最后一个 fingerprint 匹配的通过阶段继续，不重跑上游。

## 6. 严格失败与降级

只有 `completed`、全部强制验证为 passed，且最终 `artifacts.target_zone == "local-ir-reading"` 时，调用方才能导入正常阅读区。

以下情况严格禁止进入 `local-ir-reading`：

- 任一清洗 chunk 未通过本地校验或必跑语义审计；
- 全文校验、导读校验或导读审计失败；
- 调用硬预算耗尽；
- receipt 不完整或 artifact/hash 不一致；
- 译文缺少必须的原文链接；
- 外部生产服务失败且没有已通过的 checkpoint 可恢复。

内容或审计失败应进入 `preprocess-review`，保留原始材料、最近候选、失败包和恢复 checkpoint；译文缺原文进入 `translation-quarantine`；基础设施失败返回 retryable error。强制门失败时不得靠 `completed_with_warnings` 或“保留正文”把未通过产物送入正常阅读区。

## 7. 开发期三角色 Subagent 闭环

开发期允许使用三个有界角色，主 Thread 只保留压缩 checkpoint：

- 单一写入 Agent：依据一个结构化失败包修改通用规则、状态机或验证器；不为单一材料写特例。
- 只读审查 Agent：核对合同、状态迁移、幂等、receipt、失败区路由和测试覆盖，不与写入 Agent 同时修改文件。
- Canary Agent：在全新输出目录运行合成 fixture 或获准的公开 Canary，输出阶段、错误码、相关 hashes、调用数和待审核 Markdown，不把完整长日志送回主 Thread。

一次开发循环固定为：

```text
规则级修改
→ 单元/合成测试
→ 只读审查
→ 新目录 Canary
→ 压缩 failure packet 或 pass receipt
```

Canary 失败包直接交给单一写入 Agent 做下一次规则级修复。若相同失败连续两轮出现，停止追加人工补丁，回到合同、分块或验证规则重新定位；不得用人工改最终 Markdown 冒充接口通过。主 Thread 只接收每轮版本、变更摘要、失败分类、验证结果和最终审核文件。

## 8. 通过标准

一个运行只有同时满足下列条件才算通过：

- 从原始输入开始，未注入人工修订后的最终正文；
- 所有阶段 checkpoint 和 hashes 可追溯；
- 每个最终正文候选通过本地校验与必跑语义审计；
- 导读层通过本地校验与独立审计；
- 确定性渲染的正文锚点和洞察跳转真实存在；
- receipt 完整记录包括失败尝试在内的实际调用；
- 最终状态为 `completed`，错误数组不含强制门失败，target zone 为 `local-ir-reading`；
- 相同规范化请求重放时得到幂等 replay，不重复调用外部模型。
