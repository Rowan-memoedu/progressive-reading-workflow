# QQ / 微信链接收集实验

已确认范围：只接受现有已配对用户发给 Bot 的私聊文本链接（包括公众号 URL）。群聊、其他发信人、启动前的旧消息和无链接文本不进入导入流程。公众号分享卡片不在本轮范围。

## 使用

向 QQ 或微信 Bot 中任意一个发送一条公开文章链接即可。首次实验等待首条新链接；收到后约 15 秒内提交现有后台导入服务，文章加工所需时间取决于原工作流。首次导入到达成功、失败或待核验状态后结束即时实验模式。后续新链接每天本机时间 20:00 批量处理；当日 20:00 后开机登录会补执行当日批次。关机期间不保证收齐消息。

成果进入阅读区 `Bot收集`；已有文章由原工作流按来源 URL 去重，不强制复制到新目录。消息只用于提取链接，不作为模型指令。此服务不回复 QQ / 微信消息。

## 后台与状态

- Windows 任务：`ProgressiveReading-BotInbox`，当前用户登录时启动，隐藏窗口。该任务运行本地 Node CLI，不使用 Codex 定时任务或前台 Thread。
- 数据：`D:\AppData\BotReading`。`bot-home\qq`、`bot-home\weixin` 保存加密配置和新事件；`state.json` 保存处理状态；`health.json` 保存接收器与导入服务心跳。上述文件不得提交 Git 或上传。
- 原 `%USERPROFILE%\.cn-im` 保留作为既有 CLI 配置；本后台显式使用 D 盘数据根，因此普通 `qq-cli messages list` 不会自动看到此后台的新事件。
- 可用 `node scripts/bot-reading-service.mjs --status` 查看安全摘要；事件原文只在本地私有目录。
- 接收器断线后重连，微信持续长轮询。现有导入服务健康时直接复用；不可用时启动项目已有服务，由共享消费者自行解析持续同步与旧指针。Bot 不把旧指针注入为显式手动快照，否则会关闭自动同步接收端。

## 导入与验收

复用 `/api/browser-import/requests`，传递稳定的 `client_request_id`。不确定的提交结果重用同一 ID；已获得请求 ID 后只查询状态。现有导入器负责质量校验和有限重试。

本适配层只有在请求终止、成功导入一篇、实际阅读区 Markdown 非空且 SHA-256 与上游回执一致时才记 `completed`。鉴权、JS 页面或抓取失败保留原分类；文件缺失或哈希不匹配记 `unresolved`，不冒充成功。失败不会被默默删除，也不自动无限重复提交。

本地验证命令：`node --test scripts/test-bot-reading-service.mjs`。覆盖授权发信人边界、旧消息隔离、URL 去重、网络不确定时的幂等提交、产物验收，以及旧指针丢失时两次真实服务启动都保持自动同步接收端。完整真实文章验收等待用户发来的第一条链接。

## 停用与恢复

暂停：`Stop-ScheduledTask -TaskName ProgressiveReading-BotInbox` 并 `Disable-ScheduledTask -TaskName ProgressiveReading-BotInbox`。

恢复：`Enable-ScheduledTask -TaskName ProgressiveReading-BotInbox` 并 `Start-ScheduledTask -TaskName ProgressiveReading-BotInbox`。

停止只针对本任务；不停止此前已存在的共享导入服务，不删除原消息、文章或凭据。若需重新扫码，应在本后台使用的 D 盘 `CN_IM_HOME` 下操作，避免更新错配置目录。
