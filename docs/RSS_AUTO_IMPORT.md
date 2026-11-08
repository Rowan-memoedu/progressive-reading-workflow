# RSS 自动导入渐进阅读

统一入口见 [UNIFIED_SUBSCRIPTIONS.md](UNIFIED_SUBSCRIPTIONS.md)。激活后通过本地订阅页编辑来源，原 Markdown 仅保留为迁移输入；三个处理模式和已导入材料继续保留。下文的 180 天窗口、每 5 分钟轮询与暂停状态属于旧机制，统一流程采用当前 Feed 条目及后续新增、每日 06:00 检查和持续入库队列。

## 用户入口

编辑 [RSS 自动导入.md](<D:/AppData/RSSImport/RSS 自动导入.md>)，在三个相邻区域中逐行填写“网站名称：RSS 链接”，也接受 Markdown 链接。配置和运行状态在 `D:/AppData/RSSImport`，不进入 Git。

| 区域 | 处理方式 | 去向 |
|---|---|---|
| ① 标准流程导入 | 正文抓取与现有 LLM 标准处理 | Obsidian 阅读区 |
| ② 原文直接导入 | 正文提取与 Markdown 转换，不调用 LLM，不摘要、翻译或改写 | 同一 Obsidian 阅读区 |
| ③ 日报与周报 | 只交给原有报表系统，沿用其处理与时间规则 | 日报周报系统，仍暂停 |

- 第一、二区默认回溯 180 天，每 5 分钟读取 RSS；当前 `enabled=false`，待填写和测试后恢复。
- 180 天只筛选 RSS 当前返回的条目，不扩展网站归档或抓取文章正文中的外链。
- Feed 中所有条目均被登记，未设置条数截断。有效日期在范围外或未来的条目有明确状态；无日期条目导入并标记 `date_unknown`，无文章 URL 的条目标记 `missing_url`。
- 前两类发现内容后按所属区域自动处理，无逐篇审批。默认目标是阅读区 `RSS`，全局已有文章保留原位置、处理方式与人工修改。

## 实现边界

1. `rss-import/config.mjs` 统一解析三个区域、网站名称和默认模式。`rss-import/core.mjs` 只按 ETag/Last-Modified 读取第一、二区，保留 XML 快照和逐项覆盖记录；304 后仍重算日期范围。报表的 `rss-source subscriptions/sync-all` 只读取第三个区域，不再接受旧 JSON 订阅输入；历史包也按第三类当前 Feed 列表过滤，原有账本保留。
2. 对合格文章 URL 建立持久待导入记录；同 URL 在多个订阅出现时只建立一个任务，保留所有订阅归属。
3. 通过 `POST /api/browser-import/requests` 提交 `source=rss_auto_import`、`entry_route=ai`、显式 `destination_folder=RSS` 和 `processing_mode=standard_preprocess|original_text`。模式随持久任务保存；同一请求 ID 不能换模式。同时最多 2 篇在途，其余持久排队，不截断。
4. 共享 worker 抓取文章正文。标准模式调用唯一 LLM 预处理；原文模式直接使用已有正文转换与阅读区写入函数，保留原语言，回执写入 `llm_used:false`。两者共享来源 URL 去重、文件保护、正文完整性检查与侧车元数据，不另建发布器。后端未声明原文能力时，RSS 入口停止提交，不能退回 LLM 模式。
5. 每次提交前保存确定的 `client_request_id`；POST 回应丢失后重用同一 ID。只有终态失败重试时才增加尝试号，并保存旧失败回执。
6. 只有成功终态、匹配处理模式的回执、正式 Markdown 位于阅读区、非空且 SHA-256 相符，才计入成功；原文模式还须明确 `llm_used:false`。去重命中既有文章时保留其原处理方式，并记录 `preserved_existing`；质量警告不冒充无警告成功。
7. 普通失败从 30 分钟逐步退避到最长 6 小时后自动重试；需要登录/JS 渲染的来源和成功回执的文件验证失败会单独标记，不循环重写用户文件。
8. Obsidian 已运行时，通过其原生 CLI 核验正式文章的索引；目录联接导致漏索引时，只刷新对应文件的索引，不重写正文、不重载整个应用。应用关闭时继续正常落盘，每分钟重试可见性检查；应用下次打开后再核验。状态中 `obsidian` 与正文导入结果分开记录。

`state.json` 是自动导入账本；`status.json` 是逐源/逐文状态；`health.json` 保存本进程心跳；`receipts/` 保存每次导入证据；`feeds/` 保存变化的 XML 快照。配置出错时进程继续存活并报告错误，修正文档后自动恢复。标准后端离线时保留队列，后端恢复后继续。

源移除、移动类型或缩小日期范围后，尚未提交的任务按新配置处理，既有数据保留；已交给共享后端的任务可继续完成。同一个 Feed 跨区域重复会报配置错误；同一待处理文章来自两种不同导入类型时标记 `route_conflict`，不擅自选择 LLM。`source_blocked` / `verification_failed` 应先解决具体阻塞，不能删除历史回执或假装成功。

## 命令和服务

在 `D:/Projects/渐进阅读工作流` 运行：

```powershell
npm run rss:import:status
npm run rss:import:scan
npm run rss:import:run -- --wait-seconds 1800
npm run rss:import:check
npm run rss:import:service -- -Action Install
npm run rss:import:service -- -Action Status
npm run rss:import:service -- -Action Pause
npm run rss:import:service -- -Action Resume
```

`scan` 只取 Feed 并登记待处理项，不提交文章；`run` 执行一次，可等待完成；`watch` 用于持续服务。服务运行期间的手动 `scan/run/watch` 会被单写入锁拒绝；`status` 随时可读。暂停服务再手动运行，完成后可恢复。

Windows 计划任务 `ProgressiveReading-RSS-Import` 在当前用户登录后启动持续服务，异常退出自动重启；工作过程不打开 Chrome 或要求用户保持 Obsidian 窗口在前台。服务依赖现有标准后端，可通过 `imports/app-server.json` 自动定位活动端口，不重启或接管共享后端。电脑关机或用户未登录期间不抓取；恢复运行时按 Feed 当前内容补抓，RSS 已移除的历史项不保证可重建。

可见性核验使用 [Obsidian 官方 CLI](https://help.obsidian.md/cli) 的 `eval`；定向索引刷新用运行时探测到的 `DataAdapter.reconcileFile`，该内部方法如因版本变化不可用，会记为 `index_refresh_unavailable`，不会覆盖文件或阻止 RSS 正文入库。

日报周报始终独立控制：

```powershell
npm run rss:reports:pause
npm run rss:reports:resume
```

上述命令仅禁用/启用原有 `ProgressiveReading-RSS-Daily` 和 `ProgressiveReading-RSS-Weekly`，保留触发器与任务定义。不会启动、停止或清除 RSS 自动导入。恢复后，报表订阅只从本文档第三个区域取得；第一、二区不会因此进入报表系统。

任务暂停前的 XML 定义保存在 `D:/Artifacts/RSS-AutoImport-20260914/schedule-before`。回滚本次自动导入可暂停新服务，保留数据，按需恢复旧日报周报；没有破坏原有工程架构。

## 当前阶段与验证边界

2026-09-15：本次只搭建并做语法、配置解析和服务暂停状态检查；按用户要求，尚未运行测试、抓取新订阅或调用 LLM。回归用例已随三类路由更新，真实标准模式和原文模式 Canary 等待用户填写第一、二区后执行。新后端模式在测试后再载入活动服务，当前不宣称已验收。


旧配置只读快照位于 `D:/Artifacts/RSS-Routing-20260915`；它们是迁移取证材料，不是订阅输入。测试后把配置 `enabled` 恢复为 true，并恢复 RSS 导入计划任务；日报周报继续 Disabled。
