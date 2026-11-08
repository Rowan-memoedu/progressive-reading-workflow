# 渐进阅读体系：阶段、模块与接口

## 材料生命周期

1. 导入与预处理：网页入口、浏览器扩展或 Obsidian 提交 URL/页面快照；共享后端采集、提取、标准处理并发布 Markdown。
2. 阅读与加工：浏览器和 Obsidian 宿主消费共享文档核心，管理高亮、批注、问答、挖空和随想；宿主维护阅读队列与人工优先级。
3. 导出与复习：宿主生成版本化导出包；正式归档器校验、写入 RemNote、回读并产生回执。

`export_package_ready` 只表示包已准备，不能作为 RemNote 导入或复习完成的证据。

## 导入后端

`scripts/progressive-reading-app.mjs` 提供本地 HTTP 服务，默认端口 37829。`/import` 与浏览器、Obsidian 共用 `POST /api/browser-import/requests`；查询同一请求可恢复状态，不重复提交。当前页快照和 URL 抓取共享预处理、产物要求与发布器。

常规 URL 采用 `background_fetch`，旧扩展 worker 不领取新任务。Cookie 从版本化本地快照读取并热更新；返回的状态不包含值或快照路径。认证失败、JS 渲染要求和正文提取失败分别返回可见状态。

缺少用户所要求的译文或导读时不发布原文回退。保存与完成阅读相互独立；标准处理产生的初始评估不持续覆盖人工优先级。具体协议见 [浏览器导入接口](BROWSER_IMPORT_REQUEST_INTERFACE.md)。

## 标准预处理

`standard-preprocessing/index.mjs` 是主包 `./preprocess` 导出；CLI 为 `pr-preprocess`。合同为 `progressive-reading.preprocess.request/v1` 与 `progressive-reading.preprocess.result/v1`。模块只负责原始 Markdown、来源元数据和指令到阅读产物及回执，不负责来源登录、宿主 UI 或 RemNote 写入。

源码版本由模块常量与健康接口给出；文档中的历史测试不代表当前运行版本。产品提示词属于处理器源码，运行输入、模型输出和验收回执留在本机。

## 共享文档加工

`document-core/` 提供无宿主依赖的 ESM 导出，浏览器构建从同一实现生成。`local-ir.document-state/v1` 保留来源定位、批注、改写及卡片状态。薄适配器负责读写与呈现，避免宿主各自复制算法。

浏览器保存到 Markdown 与内部 sidecar；单向 handoff 后由 Obsidian 持有状态写权限，不自动双向合并。人工已改动的正文、标注和优先级受保护；旧路径、旧 sidecar 与重复片段的兼容由模块测试覆盖。

Obsidian 源码位于独立仓库 [ObsidianLocalIR](https://github.com/Rowan-memoedu/ObsidianLocalIR)。跨仓库测试通过环境变量选择源码，不依赖某个开发会话或旧工作区副本。

## 统一订阅

`subscription-workflow/` 负责设置、规范化来源身份、队列、状态和报表；复用 `rss-source/`、`rss-reading/`、`rss-import/` 与 `video-workflow/` 的来源处理器。

网页维护订阅；Markdown 周报继续承载筛选操作。自动入库动态和待筛选卡片分开记录。修订保留旧稿，失败进入重试等待，不把失败报告混入正文。旧 RSS 自动任务与统一调度不能同时启用。配置、时间和恢复方法以 [统一订阅工作流](../UNIFIED_SUBSCRIPTIONS.md) 为准。

## 正式归档

Obsidian 批量归档后端负责生成 native-v2 JSON 包并止于 `export_package_ready`。`scripts/import-remnote-queue.mjs` 从该包开始，负责 schema、哈希、幂等、精确目标校验、dry-run、RemNote 写入及回读。

有内容分支必须逐项写入或对账并回读；零内容分支必须核验本次宿主显式确认和精确目标，并生成 `no_remnote_content` 回执，不伪造空白笔记。

宿主真实弹窗与 receipt 到插件/sidecar 的最终状态同步仍须独立验收。离线检查或包生成成功均不能升级为端到端归档已上线。合同与限制见 [正式归档模块](../../remnote-formal-archive/README.md)。

## 数据和运行边界

源码与运行数据分离。`imports/`、`.local-ir/`、阅读区、归档区、队列和报表不进入 Git。实际订阅、Cookie、库安装回执与恢复记录均保留在本机。旧机器组件快照可供既有本机工具读取，但不发布，也不决定当前组件状态。

日常服务通过固定入口运行，不以工程会话 ID 发现模块。健康接口、已部署版本与实际用户路径共同决定运行状态；测试通过不等于宿主已重载或真实网站仍然可访问。
