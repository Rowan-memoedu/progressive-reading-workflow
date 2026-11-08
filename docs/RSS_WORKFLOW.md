# RSS 来源、摘要筛选与正式阅读工作流

统一订阅入口见 [UNIFIED_SUBSCRIPTIONS.md](UNIFIED_SUBSCRIPTIONS.md)。激活后，来源配置以本地订阅页为准，RSS 每天 06:00 检查、日报 09:00、周报周日 21:00。下文保留 RSS 来源包、预览与账本机制；其中旧 Markdown 配置、暂停状态和输出位置仅适用于尚未迁移的旧入口。

## 三层边界

RSS 工作流由三个单向层组成：

1. `rss-source/` 负责 Feed 发现、订阅表、获取、条件请求、身份去重、原始材料和来源包。
2. `rss-reading/` 只读来源包，维护可追溯选择状态；长文筛选稿写入 `摘要区/RSS/`，短文周报直接写入 `阅读区/RSS/短文周报/`。
3. `pr-preprocess` 负责正文清洗、翻译、导读卡、洞察和最终阅读 Markdown。只有摘要层明确授权的单篇材料才能发布。

摘要消费者不得抓取 Feed、补抓正文、复做身份去重、用摘要冒充全文，或直接生成正式阅读正文。

## 来源层 v1.2.0

订阅事实统一位于 `D:/AppData/RSSImport/RSS 自动导入.md` 的第三个区域“日报与周报”。旧 `config/rss-subscriptions.v1.json` 输入已移除，不能继续通过 JSON 配置订阅。第一、二区不进入报表来源层；报表扫描历史来源包时也只接受第三个区域当前列出的 Feed。来源包仍位于 `imports/rss/source-v1/packages/`，批量回执仍位于 `imports/rss/source-v1/batches/`，历史内容与决定保留。

```powershell
npm run rss:source:subscriptions
npm run rss:source:sync:all
npm run rss:source:discover -- --url <website-url>
npm run rss:source:validate -- --feed-url <feed-url>
npm run rss:source:check
```

只有 `content_status=fulltext_ready` 且 `preprocessing_handoff=request_ready`、存在有效 `preprocess-request.json` 的来源包可以进入正文处理。`summary_only`、`fetch_required`、`fetch_failed` 只在摘要中显示阻塞状态。

## 摘要筛选层

```powershell
npm run rss:reading:status
npm run rss:reading:queue
npm run rss:reading:migrate-legacy
npm run rss:reading:daily
npm run rss:reading:weekly
npm run rss:reading:canary
npm run rss:reading:clearance
npm run rss:reading:check
```

稳定输出：

- 长文增量日报：`摘要区/RSS/YYYY-MM-DD RSS 日报.md`
- 累积未决长文周报：`摘要区/RSS/YYYY-Www RSS 长文周报.md`
- 短文周报：`阅读区/RSS/短文周报/YYYY-Www RSS 短文周报.md`
- Review ledger：`imports/rss-reading/review-ledger.v1.json`
- 生成回执：`imports/rss-reading/runs/<run-id>/receipt.json`
- 筛选预览回执：`imports/rss-reading/previews/<material-id>/<request-hash>/`
- Canary 回执：`imports/rss-reading/canary/<canary-id>/verification.json`
- 旧摘要历史归档：`摘要区/RSS/历史归档/legacy-v0/`
- 旧输出迁移回执：`imports/rss-reading/legacy-output-migration.json`

长文日报是当日新增候选，长文周报是截至生成时跨周累积的全部活跃未决长文。两者按来源分组，每篇只显示标题、原文链接、当前状态和紧凑摘要卡：`一句话核心`、`为什么值得读`、`可能新增量`、`预计阅读成本`、`建议读法`。`material_id`、`content_status`、路由、字符数、批次和文件路径等机器字段只保留在 ledger 与 JSON 回执，不进入正文。候选滚入周报后，旧日报仅保留只读历史快照，审批入口唯一。

最新 RSS 长文周报是长文的唯一审批入口。活跃长文卡只提供三个互斥动作：`正式入库（自动处理并发布）`、`稍后再看（入库后 Later 7 天）`、`不保留`。不勾选任何动作即维持 `unresolved`，不再提供“保持未决”按钮。旧日报改为只读历史快照，并直接链接当前长文周报；本地网页应用只显示运行状态，不提供第二套审批入口。

短文不进入审批流。每周运行把本周尚未交付的短文通过 `pr-preprocess` 生成可直接阅读的 `中文主文 + English Appendix`，一次写入阅读区短文周报；没有新增短文时不创建空周报。

每条候选只有一个 ledger `选择状态`：

- `unresolved`：未决定，任何批处理都不得自动归档。
- `selected`：用户在当前摘要入口选择正式入库；消费者随即调用 `pr-preprocess` 严格发布，不存在第二次发布按钮。
- `deferred`：先完成与 `selected` 相同的正式发布，再写入 Local IR 标准 sidecar，设置 `status=later` 与 `deferUntil=7 天后`。
- `dismissed`：不保留正文，决定仍留在 ledger；如需恢复，使用当前长文周报重新纳入下一轮，而不是网页面板。

当前发布授权只允许与 `selected` 同时出现。历史 22 条决定会守恒迁移为 14 selected、8 unresolved，但历史选择本身不构成当前发布授权，当前面板和日报会提示重新确认。

长短分流是摘要产品路由，不是内容判断：当前兼容阈值为 1200 个有效字符；低于阈值进入周报，高于或等于阈值进入日报长文候选。人工决定始终覆盖自动路由。

内容预览不复制内容处理逻辑：长文摘要卡来自 pr-preprocess 的结构化语义结果；短文中文主文来自 pr-preprocess 标准翻译结果。长文优先使用完整输入的低成本判断层；若严格保真校验拒绝，则改用明确标记的有界筛选节选走标准工作流，回执记录 `preview_variant`，不得把节选冒充全文。预览运行不带 `--publish`，不会写入阅读区。

每次运行都重新扫描全部来源包，以材料身份与来源修订/status 的差异判断增量；不把发布时间、抓取时间或 Feed 顺序当游标。同日重跑只追加新修订，`fetch_required → fulltext_ready` 会重新进入路由。没有新增长文时不创建空日报。

外层编排保持与来源实现解耦：

```powershell
npm run rss:orchestrate:daily   # 先完整 sync-all，再生成长文增量日报
npm run rss:orchestrate:weekly  # 先完整 sync-all，再生成两类周报
```

周期执行使用 Windows Task Scheduler 直接调用上述 CLI，不经过 Codex 或模型：

```powershell
npm run rss:schedule:install
npm run rss:schedule:status
npm run rss:schedule:remove
```

`ProgressiveReading-RSS-Daily` 每天 07:00 运行；`ProgressiveReading-RSS-Weekly` 每周日 21:00 运行。包装器位于 `scripts/rss-reading-scheduled.ps1`，日志和原子状态回执写入 `imports/rss-reading/scheduler/`。命令内部始终保证来源完整同步先于下游生成；Codex 只在失败后用于诊断，不属于正常执行链。

清退校验逐份验证 W28/W29 历史短文周报在活动目录中存在，且与哈希保全归档一致。旧式 `YYYY-Www RSS 周报.md` 只有在新长文周报与阅读区短文周报均已存在、没有活动引用且归档副本哈希一致时，才会迁入 `摘要区/RSS/历史归档/consumer-v1-obsolete/`。

## 正式阅读发布

```powershell
npm run rss:reading:decision -- --material-id <id> --decision selected
npm run rss:reading:decision -- --material-id <id> --decision deferred
```

发布前必须同时满足：

1. 来源包为 `fulltext_ready` 且前置请求存在。
2. Ledger 状态为 `selected`。
3. 当前授权来自最新 RSS 长文周报中的单次明确动作。
4. `pr-preprocess` 结果为 `completed` 或合格的 `idempotent_replay`。
5. `processing_state=rendered`、`target_zone=local-ir-reading`。
6. `publication.status=published`、`cleanliness.valid=true`，最终文件哈希与回执一致。

最终长文单篇文件只能平铺发布到 `阅读区/RSS/<标题>.md`。短文周报只允许写入 `阅读区/RSS/短文周报/`。审计运行保存在 `imports/preprocess-runs/rss/<material-id>/`，不得把审计目录放进阅读区。

实际运行状态以本机健康接口和来源返回为准。公开源码不附带私人材料与历史运行回执；合成回归入口见 [安装与兼容性](SETUP.md)。
