# 渐进阅读工作流

将网页、文档和字幕导入本地 Markdown 阅读区，经过阅读、批注与加工后，按需导出到 RemNote。

本仓库包含导入后端、Chrome 高亮扩展、共享文档核心、标准预处理、订阅与归档模块。Obsidian 阅读端见 [ObsidianLocalIR](https://github.com/Rowan-memoedu/ObsidianLocalIR)，持续同步浏览器登录态的扩展见 [ChromeCookieSync](https://github.com/Rowan-memoedu/ChromeCookieSync)。

## 启动

需要 Node.js 24 或更新版本。在仓库根目录运行：

```powershell
npm ci
npm run app
```

服务只监听 `127.0.0.1`，默认端口 `37829`。访问 `/import` 导入链接，访问 `/subscriptions` 管理订阅；`/api/highlights/health` 可查询接口、处理器版本和脱敏后的登录态状态。端口被占用时直接报错，不另开服务。

标准预处理需要配置本机生产者；纯正文模式不调用模型。Python 文档提取、凭据同步、可选视频组件和测试安装步骤见 [安装与兼容性](docs/SETUP.md)。

## 导入与订阅

- 网页链接进入持久后台队列；浏览器捕获的当前页快照也使用同一处理和发布流程。
- TXT、EPUB、PDF、DOCX 的提取及章节工具见 [rich-text-import](rich-text-import/README.md)。完整书籍的额外编排工具属于可选集成，不是网页导入的运行依赖。
- YouTube 使用可用字幕；无字幕时不自动转入 ASR。B 站视频和合集订阅复用字幕与可选图文处理。
- 订阅支持标准处理、原文直接导入、日报与周报三种模式；视频不提供原文直接导入。调度、历史范围、来源限制及迁移兼容见 [统一订阅](docs/UNIFIED_SUBSCRIPTIONS.md)。
- 知乎发现接口可能受到站点验证或风控限制。同步成功仅表示本机快照可读，不保证网站授予访问权限。

```powershell
npm run import -- "https://example.org/article"
npm run preprocess -- --help
```

## 浏览器与 Obsidian

在 Chrome 的扩展管理页打开开发者模式，加载 `browser-highlight-extension/`。扩展负责当前页导入、高亮、批注与完成阅读；外部链接由本地服务抓取，不要求唤醒工程会话。

共享模块 `document-core/` 导出纯文档加工逻辑，浏览器构建和 Obsidian 适配器消费同一实现。旧工作区路径与既有 sidecar 保留兼容解析；保存和完成阅读是不同操作，不覆盖人工已调整的正文、标注或优先级。

完整边界见 [体系架构](docs/architecture/PROGRESSIVE_READING_SYSTEM.md)、[共享导入接口](docs/architecture/BROWSER_IMPORT_REQUEST_INTERFACE.md)及 [document-core](document-core/README.md)。

## 数据与配置

- `阅读区/` 保存最终 Markdown；`待归档原文/`、`已归档原文/` 和 `RemNote 导出队列/` 保存阅读生命周期数据。
- `imports/`、`.local-ir/`、`摘要区/` 保存队列、缓存、批注状态与报表，均不进入 Git。
- 登录凭据、实际订阅、安装清单与恢复记录只保存在本机；公开仓库不提供个人阅读材料或既有配置。
- `config/import-destination-routes.json` 是可复用的默认路由。其他 `*.current.json` 和历史组件快照不是服务发现机制，也不是运行依赖。

既有 D 盘安装继续使用原数据目录；新安装可通过 `PROGRESSIVE_READING_DATA_HOME` 与 `PROGRESSIVE_READING_ARTIFACT_HOME` 指定数据、产物根目录。Cookie、订阅和旧 RSS 的专用环境变量仍优先有效。

## RemNote 归档

生成包仅表示 `export_package_ready`。先执行 `npm run remnote:archive:dry:json` 校验，再显式指定目标节点。只有写入与回读都成功，或零内容分支完成显式确认与精确目标核验后，才能推进到 `archived`。

归档模块仍有真实宿主弹窗与最终状态同步的验收边界，源码公开不表示这些环节已完成部署。接口、回滚和限制见 [正式归档模块](remnote-formal-archive/README.md)。

## 验证

```powershell
npm test
npm run browser-highlight:check
npm run web-import:test
npm run import-rules:test
```

跨仓库测试需先获取 ObsidianLocalIR 源码，并设置 `LOCAL_IR_OBSIDIAN_SOURCE`；独立运行 `document-core:adapters`、`document-core:handoff`。测试使用合成材料和隔离目录；真实导入与真实 RemNote 写入必须由调用者显式选择。
