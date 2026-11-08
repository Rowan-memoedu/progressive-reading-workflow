# 浏览器来源采集与加工边界

更新时间：2026-08-15

## 当前职责

浏览器扩展负责来源侧整页采集，以及保存前的本地加工体验：

- 采集 URL、标题、页面文本、HTML 快照、采集时间和来源类型；
- 只在用户点击“初始化加工”后创建每页未保存草稿；新网页打开时不产生草稿状态，已有草稿自动恢复；
- 在页面操作面板中提供全局互斥的“加工模式 / 挖空模式”，两者都关闭时不响应文本选择；
- 以独立元数据保存虚拟高亮、批注、改写、随想、问答卡、挖空、合并和撤销状态；
- 手动保存或关闭标签页时提交当前版本；
- `完成阅读` 时把当前 Markdown 直接提交到 `待归档原文/`，不进入阅读区；
- 保存成功后锁定草稿。

不迁移阅读池、优先级和批量归档编排。网络正文解析、视频导入和批量来源编排仍归网络内容导入工程。

## 数据分层

浏览器高亮是虚拟显示层，不进入 Markdown 正文：

```text
来源快照 -> 原始 Markdown -> 保存的正文 Markdown
                         + local-ir.document-state/v1 sidecar
```

`browser-highlight-extension/draft-core.js` 是浏览器扩展、保存服务和 Obsidian 插件共同执行的文档核心。sidecar 是浏览器来源文档的状态权威，覆盖阅读状态、完整加工类型、高亮/挖空、评论/改写、问答卡、文章随想、revision 和 handoff。浏览器文本坐标只用于网页显示；保存服务在最终 Markdown 上重新锚定，Local IR 导入旧 sidecar 时再次校验。两套坐标不得混用，模型不生成 Obsidian block ID。

## 初始化与模式生命周期

- 未初始化：页面只显示紧凑的“初始化加工”入口，不创建 draft，不提取或持久化页面快照；
- 已初始化：展开完整操作面板并持久化当前来源快照；
- 旧草稿：按 URL 自动恢复，不要求重复初始化，也不产生额外 upsert；
- 加工模式：选择文本创建普通虚拟高亮；
- 挖空模式：选择文本创建 `cloze` 虚拟标注；
- 两种模式全局互斥，并允许同时关闭；模式选择不创建额外页面草稿。

## 保存目标

- 普通保存：`阅读区/浏览器高亮/`；
- 完成阅读：`待归档原文/`；
- 两条路径均返回 `status`、`artifacts`、`source_metadata`、`receipt` 和 `errors`；
- Markdown 与内部状态文件分别通过各自目录内的临时文件加 rename 原子提交，状态文件最后提交；阅读区不出现 JSON；
- 普通保存后浏览器草稿锁定，handoff 方向固定为 `browser_to_obsidian`；首版不做双向浏览器合并；
- 旧 `/api/highlights/capture` 继续保留，不覆盖现有 canary 或旧产物。

## Obsidian 接续

- Local IR 监听 `.local-ir/browser-document-state/` 的 `.browser-ir.json`，并在刷新阅读池时按 Markdown 文件名兜底解析；按 revision、updatedAt 和内容指纹幂等导入；
- sidecar 中的 ID、加工类型、评论、改写、挖空、问答卡、文章随想和状态保持不变；
- 本地修改后，由 Local IR 递增 revision 并原子回写 sidecar；`data.json` 只保留运行缓存和跨文档队列字段，不是这类文档加工状态的最终权威；
- Markdown 重命名时同步维护内部状态文件；冲突时不覆盖较新状态；
- 旧的相邻 `schema_version: 1` / `local-ir.document-state/v1` sidecar 在首次读取时迁移到内部状态目录。

## 标准 Markdown 前置处理接口


只允许未来替换：

```text
采集侧原始 Markdown + source_type + source_metadata + user_instruction
  -> 最终标准阅读 Markdown
```

保持不变：浏览器采集、Readable 正文提取、虚拟高亮来源证据、原始 Markdown 与来源元数据生产。当前正式 canary 不等待接口；shadow 接入须获得本任务用户明确授权，不能直接切换生产路径。

建议 shadow request：

- `material/input`: `browserPageToMarkdown()` 的原始 Markdown；
- `source_type`: `browser_page`；
- `source_metadata`: `source_url`、`source_title`、`captured_at`、`capture_agent`、`raw_markdown_sha256`、`draft_id`、`draft_revision`；
- `user_instruction`: 草稿字段原样透传。

消费：`status`、`artifacts`、`source_metadata`、`receipt`、`errors`。

DOM、Cookie、登录态、可见浏览器状态、浏览器文本坐标和加工元数据不进入外部 AI 请求。

## 已知字段缺口

- 当前扩展已保留 `user_instruction` 字段，但尚无单独输入 UI；默认空字符串。
- 当前页面级 source key 是 URL/草稿 ID；尚未生成稳定的 Markdown `source_block_key`。
- 重新锚定找不到唯一可靠位置时，标注保留为 orphan，等待本地人工修复。
- 当前只实现浏览器到 Obsidian 的一次性 handoff；浏览器保存成功并锁定后不再参与合并。
- 真实 Chrome 重载、保存与 Obsidian UI 接续 canary 尚未执行；离线检查不读取浏览器存储。
