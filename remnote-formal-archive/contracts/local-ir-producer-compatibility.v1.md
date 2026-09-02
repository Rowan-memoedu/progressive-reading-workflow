# Local IR 生产者兼容合同 v1

> 历史兼容合同。当前合同为 `local-ir-producer-compatibility.v2.md`；本文件仅保留 native-v1/legacy-v2 追溯。

## 当前兼容输入

导入器继续接受 Local IR 0.6.8 产生的 `schemaVersion: 2` JSON，不要求工程四立即改名、重建 Thread 或另建状态库。兼容层会：

- 根据 `sourcePath` 派生稳定 legacy `packageId`；
- 不信任旧 `importStatus` 的成功语义；对已有 `remnote.*RemIds` 必须按目标父文档、标题和来源路径重新回读对账，对账不通过时拒绝新建以防止重复；
- 把旧生产者的 `status: archived` 视为 `export_package_ready` 兼容输入，并在 plan/receipt 中记录警告；
- 不自动调用 AI 补全问答卡，未补全卡片会使 schema 校验失败。

## 生产者后续需补齐的 native-v1 字段

```json
{
  "schema": "progressive-reading.local-ir-export-package/v1",
  "packageId": "stable producer-assigned id",
  "packageRevision": 1,
  "status": "export_package_ready",
  "title": "Article title",
  "sourcePath": "vault-relative original source path",
  "localArchive": {
    "state": "export_package_ready",
    "sourcePath": "vault-relative staging source path",
    "archivedSourcePath": "vault-relative final archive path"
  },
  "annotations": [],
  "cards": [],
  "clozeCards": [],
  "articleMusings": []
}
```

工程四后续发布时应做三个最小调整：

1. `批量归档已完成` 改为“批量生成导出包”，记录状态只到 `export_package_ready`。
2. 原文保留在 `待归档原文/`，或由 `localArchive.sourcePath` 指向等价 staging 路径；只有工程五回读成功后才移到 `已归档原文/`。
3. 插件显示将“已生成导出包”与“已正式归档”分开；后者必须以工程五 receipt 或对应回写为依据。

## 当前缺口的影响

对 legacy-v2 包，工程五可以保证 RemNote 幂等、回读和 receipt，但无法改变“原文早已被移动”的历史时序。在生产者调整发布前，组件注册表不得标记为 `released`。
