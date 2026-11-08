# 共享文档加工核心 0.1.0

共享标注记录与可逆变化；浏览器、保存服务和 Obsidian 使用同一份 `core.js`。无服务、DOM、CodeMirror、文件系统或外部模型依赖。

## 入口与职责

- ESM：`document-core/index.mjs`；包入口 `@local-ir/document-core`，类型 `index.d.ts`。主项目也导出 `./document-core`。
- 浏览器：`browser-highlight-extension/draft-core.js` 是 `core.js` 的字节相同 classic-script 产物，同步提供 `globalThis.LocalIrDraftCore`。manifest、background `importScripts`、popup 和 background 动态注入沿用此唯一入口。
- 服务：`scripts/progressive-reading-app.mjs` 从 ESM 入口读取模型和定位函数。
- Obsidian：`main.ts` 从 ESM 入口调用 `mergeRecords`、`addRecord`、`deleteRecords`、`createChange` 和 `applyChange`；手动合并、重叠/同 block 自动合并、删除、撤销及虚拟重做均已接线。
- 宿主提供选区坐标与 `textForRange(range)`，处理 Markdown 保护、DOM/CodeMirror、文件、sidecar、渲染和草稿生命周期。合并几何时应传入该函数，从各并集区间读取原文，避免吞入离散间隙。

## API

| API | 返回与语义 |
| --- | --- |
| `mergeRecords(records, ids, options)` | `{records, annotation, change}`；最早区间保留主 ID，同起点按 ID 确定顺序；拒绝混合 markKind、跨文档和冻结记录 |
| `addRecord(records, annotation, options)` | 同结构；真实重叠自动合并，相邻不自动合并；宿主可用 `mergeIds` 提供同 block 候选 |
| `deleteRecords(records, ids, options)` | `{records, change}`；只删记录，缺失 ID 无操作 |
| `createChange(before, after, kind)` | 只包含变化 ID 的 before/after 快照 |
| `applyChange(records, change, direction, options)` | `forward` 或 `backward`；先验证所有受影响 ID，过期快照抛错且输入零变化；保留无关记录和编辑 |
| `anchorAnnotationsToMarkdown(records, markdown, path)` | 保留多片段；原范围匹配优先，转换后用片段上下文消歧；重复且无法唯一定位或缺片段时 orphan，清空有效范围 |

`options` 支持 `path`、`frozen`、`locked`、`at`、`textForRange`、`mergeIds`。宿主应将冻结状态传入或在调用前拒绝。API 不修改传入对象。浏览器原有草稿、QA、随想和锁定 API 保持兼容。

规范化及所有有效范围读取中，显式 `virtualRanges` 是宿主当前范围，空数组表示清空且不回退旧 `range/sourceOffset`；缺失时才读取旧浏览器 `ranges`，两数组均缺失时兼容历史 `range`。因此 CodeMirror 映射后的新位置不会被旧副本覆盖，缺省旧结构也不会误当清空。

评论和改写按文中位置逐条拼接；完整来源记录保存在 `mergedSources`，保留来源 ID、原文/当前文本、类型、定位、层级和扩展字段。主记录保留原有 ID、originalText 和层级；currentText 为并集片段文本。片段携带 sourceRange 和上下文供保存重定位。旧 document-state/legacy sidecar 可继续 roundtrip，schema 不升级。

删除加工记录/虚拟装饰不删除正文，不扩大 QA 级联、已应用改写还原或旧 inline mark 解包范围。Obsidian 新操作用共享 change；内存中的旧操作仍有兼容读取路径。虚拟 undo/redo 仅在当前文件、正文未变且快照未过期时执行；过期操作保留在历史中并提示拒绝。

`ReadingMaterial` 类型仅预留中立的链接/文本输入；本轮未增加剪藏 UI、双向同步、标准加工或归档重写。

## 验证和隔离构建

纯模块只需要 Node：

```powershell
node document-core/test.mjs
```

跨端验证需显式指定现有 Obsidian 源码目录，其已有 esbuild 和 CodeMirror 依赖用于运行真实 `main.ts` 方法；不启动 Obsidian、不读取用户 data.json。

```powershell
$env:LOCAL_IR_OBSIDIAN_SOURCE = '<Obsidian plugin source absolute path>'
node document-core/adapters.test.mjs
$env:LOCAL_IR_HANDOFF_PORT = '39347'
$env:LOCAL_IR_TEST_ARTIFACTS = 'D:\Artifacts\local-ir-document-core'
node document-core/handoff.test.mjs
```

handoff 使用合成文章，真实启动现有保存服务并读取落盘结果，再调用真实 Obsidian sidecar 导入方法。端口占用即失败，看到本次子进程成功监听才可发送；不改活动服务发现文件。每次隔离目录保留 receipt、正文、sidecar 和日志。

```powershell
node document-core/build.mjs
# 在 Obsidian 源码目录执行：
$env:LOCAL_IR_BUILD_DIR = 'D:\Artifacts\local-ir-document-core\obsidian'
node esbuild.config.mjs production
```

浏览器构建默认写 `D:\Artifacts\local-ir-document-core\browser-extension`，可用 `LOCAL_IR_CORE_BUILD_DIR` 更改；包含所有现有加载入口与 SHA256 清单。原子同步兼容门面使用 `node scripts/sync-browser-highlight-extension.mjs`，该命令会更新源码目录的扩展产物；独立复核只运行测试/隔离构建即可。

既有回归：主项目 `npm run browser-highlight:check`；Obsidian 源码目录 `npm test`。测试临时目录通过 TEMP/TMP 指向 D 盘。浏览器回归测试使用合成 producer，不调用外部模型。

## 交付边界

没有重载 Chrome 或覆盖已安装 Obsidian 插件。Chrome unpacked 扩展若指向源码目录，下次自行重载会读取已同步的兼容产物。Obsidian 隔离构建须由协调任务审查后再安排部署。真实宿主快捷键、选区和视觉装饰仍需手测；自动测试不冒充界面验收。

已有工作树包含本轮前改动，未将其提交、重置或混入可直接反向应用的回滚补丁。隔离构建可删除或重新生成；活动 Obsidian 尚未部署，无须回滚。源码回退应只撤销本轮增量，不使用整份 `git diff` 覆盖其他任务改动。
