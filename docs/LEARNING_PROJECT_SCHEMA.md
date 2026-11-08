# 项目学习编排层 v1

## 定位

本模块不替代渐进阅读、Local IR 或 RemNote。它只负责把一次开源项目学习组织成可恢复、可验证的闭环：

`项目来源 → 环境预检 → 先修图谱 → 诊断 → 下一任务 → 实践证据 → 补缺 → 材料候选 → RemNote 晋级`

## 本地权威状态

每个项目位于 `imports/learning-projects/<project-id>/`：

- `manifest.json`：项目来源、目标、路径、策略与当前状态。
- `concept-graph.json`：概念、先修关系、任务和验收方式。
- `events.jsonl`：只追加的学习与系统证据。
- `state.json`：可由前三项重建的派生状态。
- `environment-report.json`：环境检查、AI 已完成项与最短人工清单。
- `reading-package/`：调用现有 P31 GitHub Markdown 导入器生成，不复制一套导入逻辑。
- `workspace/`：可执行源码工作区；只有明确要求时才克隆。
- `materials/candidates/`：带来源与校验结果的卡片、quiz 候选。
- `remnote-promotion-queue/`：经过人工审阅或成功作答后才能进入的晋级队列；这里仍不是 RemNote 写入。
- `exports/`：可携带、可审计的完整 JSON 导出。

## 掌握状态

v1 不伪造精密分数，只使用四个可解释状态：

- `unknown`：没有证据。
- `learning`：已有成功证据，但尚不足以证明可迁移掌握。
- `demonstrated`：至少两次成功，其中至少一次有外部可检查证据。
- `needs_remediation`：最近出现失败，需要回退到相关先修或重试。

## 材料门禁

候选必须同时具备：目标、概念、问题、答案与源码/课程来源指针。重复问题、无来源问题、不可作答问题直接拒绝。晋级还必须记录 `user_review` 或 `successful_answer`，再由既有 RemNote dry-run/导入链路处理。

## 开放课程适配器边界

后续课程适配器复用同一 manifest、事件账本与概念图，只把来源实体扩展为：

- `syllabus`
- `lecture`
- `reading`
- `assignment`
- `assessment`

课程适配器不得假设存在 Git 仓库、构建命令或源码修改任务；真实课程 canary 在 GitHub canary 验收后单独批准。

