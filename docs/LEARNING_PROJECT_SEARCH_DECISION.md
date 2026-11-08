# 项目学习辅助工具：复用决策

## 采用

- 现有 P31 GitHub Markdown 全量导入：继续作为课程与仓库文档进入阅读区的唯一入口。
- 现有 Local IR：继续负责阅读、标注和文章级加工，不修改其性能敏感热路径。
- 现有 RemNote dry-run / import：继续作为长期知识写入门禁；新模块只生成经过验证的晋级队列。
- 本地 JSON manifest + JSONL 事件账本：作为运行状态权威源，支持重建、导出和回滚。

## 借鉴

- [Gitingest](https://github.com/coderamp-labs/gitingest) 与 [Repomix](https://github.com/yamadashy/repomix)：借鉴仓库选择、过滤和模型上下文打包思路；P31 已有 GitHub Markdown 导入，因此不再复制一个抓取器。
- [learn-codebase](https://github.com/ktaletsk/learn-codebase)：借鉴预测后揭示、苏格拉底追问、持续学习日志；不把未经验证的自评当掌握证据。
- [OpenTutor](https://github.com/zijinz456/OpenTutor)：借鉴内容块、FSRS、quiz、知识图谱和多模型路由的模块边界；不整体部署其第二套工作区。
- [Math Academy](https://www.mathacademy.com/how-our-ai-works)：借鉴先修图谱、压缩诊断、学习者证据、下一任务选择和失败补救的闭环；v1 不实现伪精密掌握度分数。
- [CMU OLI](https://oli.cmu.edu/about/)：借鉴“行为证据 → 分析 → 调整内容”的持续改进循环。

## 拒绝

- 独立全栈学习平台：会重复阅读区、知识库、卡片和项目状态，迁移与退出成本高。
- 卡片优先路线：无法验证环境、代码路径、调试和实际产出。
- AI 直接写 RemNote：来源不足、重复和低价值材料会形成长期清理债务。
- 首版完整 BKT/DKT/IRT 引擎：真实行为数据不足时只会制造伪精确。

## 失败模式与退出

- 状态分裂：`state.json` 永远是派生缓存，可从 manifest、graph 和事件账本重建。
- 虚假熟练：核心任务必须包含预测、解释或外部可检查产物；单次自评不能进入 `demonstrated`。
- 材料幻觉：无来源、重复、不可作答或选项无效的候选直接拒绝。
- 工具链失败：环境报告区分 AI 可处理项和剩余人工项；同类失败两次后换路线。
- 退出：删除新增模块和 `imports/learning-projects` 即可回滚；不需要迁移或删除既有阅读区、Local IR 和 RemNote 内容。

