# Local IR 生产者兼容合同 v2

## 工程所有权与交接点

- Obsidian 阅读 UI 与“批量归档”按钮入口由工程四 Thread `00000000-0000-0000-0000-000000000000` 维护。
- 点击后的批量归档后端由独立子模块 Thread `00000000-0000-0000-0000-000000000000` 维护；它负责生成符合本合同的 native-v2 JSON，并止于 `export_package_ready`。
- 正式归档 Thread `00000000-0000-0000-0000-000000000000` 只从 JSON 包开始，负责 RemNote 写入、回读、receipt 与最终本地 `archived`。

三个边界共享同一状态语义和本合同，不得各自建立第二套状态或导入器。

## 正式成功边界

生产者只能把包推进到 `export_package_ready`。工程五完成以下全部条件后，才可写 `archived`：

1. package schema、稳定 ID、payload hash、重复与精确目标校验通过；
2. 每个来源对象都有 `covered` disposition，不允许静默丢弃；
3. 有 RemNote 条目时，MCP 写入或既有远端对账完成；零 RemNote 条目时，包必须带本次 Obsidian 弹窗产生的显式用户确认，且不得伪造空白远端节点；
4. 有条目时，每个 Rem 按 ID、父节点、人类标题、人类可见正文语义和卡片方向回读一致；零条目时，精确父目标回读一致并把 `remoteOutcome.mode=no_remnote_content` 写入 receipt；`itemKey`/`payloadHash` 和确认凭据只保存在本地 state/receipt；
5. 成功 receipt 已写入；
6. 原文从 staging 移到 final archive，包和本地 state 同步推进为 `archived`。

`export_package_ready`、旧 `importStatus`、文件移动或 Rem ID 存在都不能单独证明正式归档成功。

## native-v2 输入

权威 schema：`../schemas/local-ir-export-package.v2.schema.json`。

```json
{
  "schema": "progressive-reading.local-ir-export-package/v2",
  "packageId": "stable producer-assigned id",
  "packageRevision": 1,
  "status": "export_package_ready",
  "title": "Article title",
  "sourcePath": "vault-relative staging path",
  "source": {
    "materialType": "document | book | video_transcript | web_article | markdown_document",
    "format": "pdf-derived-markdown | word-derived-markdown | epub-derived-markdown | youtube-transcript-markdown | web-markdown | markdown",
    "origin": "source URL or null"
  },
  "localArchive": {
    "state": "export_package_ready",
    "sourcePath": "vault-relative staging path",
    "archivedSourcePath": "vault-relative final archive path",
    "noRemnoteContentConfirmation": {
      "schema": "progressive-reading.no-remnote-content-confirmation/v1",
      "confirmed": true,
      "confirmedAt": "ISO date-time",
      "missingElementKinds": ["annotations", "cards", "clozeCards", "articleMusings"]
    }
  },
  "annotations": [],
  "cards": [],
  "clozeCards": [],
  "articleMusings": []
}
```

## 完整去向合同

工程五对每个 annotation、QA card、cloze card 和 article musing 生成 disposition：

- `remnote_import`：写入对应 RemNote 类型文档并回读；
- `refined_reading`：包必须给出 `refinedReadingPath`；
- `codex_question_queue`：包必须给出 `questionQueueJsonPath` 或 `questionQueueMarkdownPath`；
- `derived_to_qa_card`：批注必须用 `sourceAnnotationId` 关联到已解析 QA card。

任何缺失 artifact、空随想、空挖空或未解析 QA card 都是 blocked disposition，apply 在任何 RemNote 写入前拒绝整个计划。文章随想从 v2 起进入 `文章随想` 文档，不再静默留在本地。

“不存在某类元素”与“已有元素损坏”必须区分：

- 文章没有任何 RemNote 可导入条目，或只有 `refined_reading` / `codex_question_queue` 等本地去向，不构成错误。Obsidian 必须弹窗列出缺失元素；用户确认后写入 `localArchive.noRemnoteContentConfirmation`，工程五按 `no_remnote_content` 分支完成正式归档且远端零写入。
- 已存在但内容为空的随想/挖空、未解析 QA card、缺失派生 artifact 仍是 blocked disposition，不能用上述确认绕过。
- 没有显式确认的零条目包继续 fail closed；旧包不得被静默升级为用户已确认。

## 向后兼容

同一导入器继续接受：

- native-v1：`progressive-reading.local-ir-export-package/v1`；
- legacy-v2：Local IR 0.7.19 曾使用的 `schemaVersion: 2` 包。

兼容层不信任 legacy 的 `status: archived`。已有 `remnote.*RemIds` 必须按目标父文档、标题和来源路径回读对账；对账失败时拒绝继续，以避免重复写入。

## 批量归档后端 1.4.0 实现状态

1. “批量归档已完成”改为“生成导出包”，只写 `export_package_ready`；
2. 原文留在 `待归档原文/` 或等价 staging，直到工程五成功 receipt 后再移动；
3. 输出 native-v2 的 `schema/packageId/packageRevision/source/localArchive`；
4. 明确输出所有派生 artifact 路径和 card 关联，不把任何类型只留在人类可读 Markdown；
5. 插件 UI 将“包已准备”与“正式归档成功”分开，后者只认工程五 receipt/回写。
6. 零 RemNote 条目先汇总显示缺失元素；取消保持 `done` 且不计失败，确认后写入审计确认字段并正常生成包。

上述六项已在 `local-ir` 0.8.5 / `batch-archive-backend` 1.4.0 中完成，并通过 15 项模块回归、TypeScript、原插件回归、工程五 0.4.0 normalize/validate、synthetic Canary、12 篇真实材料隔离 Canary和 7 篇真实旧失败记录的按钮处理器隔离 Canary。12 篇真实材料均可在显式确认后生成包，其中 9 个零条目包带确认凭据；7 篇按钮处理器样本取消时生成 0 包，确认时生成 7 包，双端校验均为零错误。所有 Canary 均保持生产 `data.json`、正式队列和原文不变，RemNote 调用为 0。

当前状态是 `installed_button_handler_canary_passed`，仍不是端到端发布：精确的已部署按钮处理器已经通过，但真实 Obsidian 窗口中的渲染 Modal 尚未目视点击；7 篇旧失败记录按安全边界保持不变，等待用户在真实弹窗确认；工程五 receipt 到插件/sidecar 的最终状态同步也尚未发布。当前正式队列已有 3 个通过 0.4.0 dry-run 的 native-v2 包，另有 1 个 legacy Markdown-only 记录；这些事实都不能替代尚缺的最终状态同步。
