# RemNote 正式归档工程

版本：`0.4.0`  
发布状态：`button_handler_canary_passed_live_modal_pending`  
稳定入口：`scripts/import-remnote-queue.mjs`

本工程是 Local IR 导出队列的唯一正式导入器。它复用现有 `RemNote 导出队列/` 和 `scripts/import-remnote-queue.mjs`，不建立第二套队列或导入命令。

## 成功语义

```text
export_package_ready
  -> schema / 包哈希 / 重复 / 精确目标校验
  -> dry-run
  -> 有 RemNote 条目：MCP 写入 + 逐项 remnote_read_note 回读
  -> 零 RemNote 条目：核验弹窗确认凭据 + 精确目标回读，远端零写入
  -> remnote_imported_and_verified
  -> receipt + 本地状态推进
  -> archived
```

仅有导出包不算正式归档。`archived` 只能由本导入器在相应分支完成后标记：有条目时必须全部写入/对账并回读；零条目时必须存在本次 Obsidian 弹窗产生的显式确认，并生成 `no_remnote_content` receipt。导入器不会为零条目文章伪造空白 RemNote 节点。

## 运行入口

在本目录调用：

```powershell
npm run remnote:archive:dry
npm run remnote:archive:dry:json
```

dry-run 不连接 RemNote，不修改队列包、state 或 receipt。相同输入会产生相同 `planHash`。

v2 会把 PDF、Word、EPUB、YouTube 字幕、网页和普通 Markdown 等来源写入标准 `source.materialType/source.format/source.origin`，并要求每个批注、卡片、挖空和随想都有可核验 disposition。完整生产者合同见 `contracts/local-ir-producer-compatibility.v2.md`。

文章完全没有批注、卡片、挖空或随想，或者只有二次阅读/问题队列去向时，仍可正常归档。生产者必须先在 Obsidian 弹窗列出缺失元素并取得确认，再写入 `localArchive.noRemnoteContentConfirmation`。dry-run 会显示 `remoteMode: no_remnote_content`；apply 仍校验精确目标、生成 receipt、移动原文并推进本地状态，但不对 RemNote 创建任何可见内容。

RemNote 只保存面向人的正文。`itemKey`、hash、package ID、来源格式、本地路径、AI/重试/归档状态全部留在本地 state/receipt，不写成 RemNote 标题或子节点。问答卡把完整 `- 问题 >>>` 加缩进答案作为 content-only Markdown tree 提交，并回读验证 `cardDirection=forward`。详见 `contracts/remnote-human-content-boundary.v1.md`。

正式写入必须显式提供精确父节点：

```powershell
node .\scripts\import-remnote-queue.mjs `
  --parent-rem-id "<exact Rem ID>" `
  --parent-title "<exact current title>" `
  --json
```

导入器不搜索或自动创建顶层父节点。使用平台可以先为本次运行创建精确父节点，再把 ID 和当前标题传给导入器。导入器先按 ID 回读并比对标题，然后才可以在该父节点下校验或创建当前包实际需要的类型文档。

## 幂等、失败与重试

- `packageId + payloadHash` 锁定一个包版本。同 ID 不同哈希按冲突包拒绝。
- `itemKey`、payload hash 和 Rem ID 映射只保存在本地 state/receipt，不污染 RemNote 人类内容。
- 每项创建后立即回读；未回读成功的 Rem ID 不算完成。
- 部分失败会保留已核验映射并生成失败 receipt。重试会先回读已记录的 Rem，再继续剩余项。
- 进程在记录 Rem ID 前中断时，重试会按精确父文档、规范化人类标题、可见正文语义和卡片方向对账，避免重复创建。
- 队列中完全相同的重复包只执行字典序第一份。
- 任一 blocked disposition 会在写入前拒绝整个计划；不存在“人类可读导出里有内容、正式导入器静默忽略”的成功路径。

## 运行数据

- `runtime/state.v1.json`：每项 Rem ID 和回读状态；仅 apply 写入。
- `runtime/backups/`：本地状态推进前的包备份。
- `receipts/`：成功、部分失败和本地回滚回执。

这些都属于同一导入器的审计状态，不是第二套业务队列。

## 回滚

本地回滚：

```powershell
node .\scripts\import-remnote-queue.mjs --rollback-receipt "<successful receipt.json>" --json
```

该命令恢复导入前的包 JSON，并在 native-v1/v2 包实际移动过原文时把原文移回 staging。它不删除 RemNote 节点；已写入 RemNote 保留作为可对账记录。如需删除，必须另行精确确认对象。

## 发布与当前阻塞

`0.4.0` 已增加“用户确认后允许零 RemNote 条目正式归档”合同、确定性 dry-run、零远端写入 receipt 和本地归档测试。既有有内容路径继续沿用 0.3.0 的真实 Canary 证据；零内容分支已通过生产者 1.4.0 的真实 7 篇按钮处理器隔离 Canary 和工程五 22 项回归，端到端生产发布仍受以下门禁阻塞：

1. 已部署插件的真实按钮处理器已通过，但尚未在 Obsidian 窗口内目视点击渲染后的确认 Modal；
2. 当前 7 篇旧失败记录按安全边界保持不变，须由用户在真实弹窗确认后才进入正式队列；
3. 成功 receipt 到插件记录/sidecar 的最终 `archived` 状态同步尚未发布。

真实 Canary 的最终证据和可调用边界见 `VERIFICATION.md` 与 `release.json`。当前使用平台可以调用 dry-run；生产 apply 必须等待真实 Modal 点击复验和 receipt 到插件/sidecar 的最终状态同步发布，不得把本版本冒充为完整生产归档已发布。

## 验证

```powershell
npm run remnote:archive:check
```

测试覆盖确定性 dry-run、schema、所有 disposition、来源格式、零内容显式确认、仅高亮/仅提问、零远端写入 receipt、幂等重试、部分失败、回读不一致、完全重复包、冲突包和真实 CLI 初始化顺序。
