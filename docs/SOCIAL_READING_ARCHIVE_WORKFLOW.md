# 个人媒体内容归档 Workflow

这套 Workflow 把知乎、小红书等平台上的点赞、收藏、收藏夹和专栏内容归档到渐进阅读区。平台差异只进入 Adapter；导入、去重、断点、验收和回执共用一条主链。

全局 Skill：`%USERPROFILE%\.codex\skills\archive-social-reading`

## 硬性阶段门

1. 先完善并离线验证 Skill、Workflow 和目标平台 Adapter。
2. 第一阶段完成前，不打开平台、不切换浏览器、不导入内容、不修改点赞或收藏状态。
3. 正式实例单独建立清单、范围、账号状态策略和验收边界。

## 登录态路线

知乎固定复用现有 Chrome 渐进阅读插件的“同步知乎与 X 登录状态”：Cookie 只进入本机服务进程内存，不写磁盘、不进回执。同步后，清单、取消状态和回读全部由本地服务 API 完成；不打开内置浏览器、不接管现有 Chrome 标签页、不模拟逐条点击。

## 执行状态机

完整归档模式：

```text
preflight
  -> inventory_frozen
  -> canonicalized
  -> handoff_ready
  -> import_verified
  -> cleanup_eligible
  -> cleanup_verified
  -> final_verified
```

明确要求“取消状态并提取链接，交给另一任务跑 Canary”时：

```text
preflight
  -> inventory_frozen
  -> cleanup_requested
  -> cleanup_verified
  -> handoff_ready
```

- `preflight`：验证本机服务、Chrome 同步登录态、API 能力、历史正文索引和回执目录。
- `inventory_frozen`：按本地时区冻结目标范围，并保存目标范围之外的第一条边界。
- `canonicalized`：扫描整个阅读区的规范化 `source_url`；同一文章只能有一份正文。
- `handoff_ready`：生成有序、去重、带 inventory hash 的 URL 清单，并为共享标准接口注入入口与目标目录；不唤醒或依赖其它 Thread。
- `import_verified`：只接受共享标准导入接口的终态、正文回读和目标目录回读证据。
- `cleanup_eligible`：只有对应导入验收为 verified 的条目才能进入；点赞与每个收藏夹成员关系分别作为 cleanup unit。
- `cleanup_verified`：需要正式实例显式允许账号状态修改；优先使用已验证的状态 API，不模拟点击。
- `final_verified`：重新读取来源集合，确认每一种用户要求清理的来源状态都已逐项验证并保存边界。点赞完成而收藏未完成，或反之，都不得判定整轮完成。

任何阶段失败都停止后续状态，保存当前 checkpoint，并从最后一个哈希一致的阶段恢复。

## 全局去重与目录

规范化来源 URL 是全局唯一身份。入口与目录映射由 `config/import-destination-routes.json` 决定：浏览器插件固定进入“浏览器高亮”，Obsidian 按域名分类，AI 指令必须显式注入目标相对目录。社交归档当前把知乎点赞注入 `知乎/知乎点赞`；改变目录时移动唯一正文并同步 sidecar，不复制正文。点赞、收藏夹和专栏的多重归属写入运行索引。

## 每次运行的产物

```text
imports/social-reading/<platform>/<run-id>/
├── run.json
├── inventory.json
├── handoff.json
├── import-receipt.json
├── import-verification.json
├── cleanup-part-NN.json
├── gaps.json
├── final-verification.json
└── validation.json
```

清单和回执采用原子写入；每批完成立即落盘。`run.json` 保存不可变输入和所有关键文件哈希。

## 知乎 Adapter

当前可执行入口：

```powershell
npm run social-archive:zhihu-likes -- --limit <N> --unlike --receipt <receipt.json>
npm run social-archive:zhihu-likes-since -- --since <YYYY-MM-DD> --unlike --import --destination-folder "知乎/知乎点赞"
```

命令通过本地服务分页读取活动 API，冻结回答/专栏点赞 URL，分别调用回答 `{ "type": "neutral" }` 与专栏 `{ "voting": 0 }` 接口并回读确认目标 URL 消失。带 `--import` 时，本任务直接把冻结 URL 分批提交给共享标准接口，设置 `entry_route: ai` 与目标目录，并保存逐批终态；不再向其它 Thread 交接。

历史运行仍作为回归证据：

- 个人动态清单与日期边界；
- 回答中立投票 API；
- 仅对 57 个已验收条目取消点赞；
- 44 个专栏归属去重为 41 篇正文；
- 删除、私有或陈旧计数条目只记录缺口，不伪造正文。

2026-08-14 的真实 canary 证明 `DELETE articles/{id}/likers` 不能解除专栏“赞同”，即使返回 HTTP 200 也不得记为成功；相对 `POST /api/v4/articles/{id}/voters` 会错误解析到 `zhuanlan.zhihu.com` 并返回 404。最终已验证合同是：从已登录的专栏文章页会话调用绝对地址 `POST https://www.zhihu.com/api/v4/articles/{id}/voters`，请求体 `{ "voting": 0 }`，随后打开新的专栏文章页并要求 `button[aria-label^="已赞同"]` 数量为 0。本次单篇 canary 和全部 16 篇文章均通过接口响应与逐篇 DOM 双重验证；后续运行继续保留显式账号修改批准、单篇 live preflight、小批次落盘和逐篇 DOM 硬门禁。

知乎收藏夹清单分页已在本次冻结 inventory 中完成 12/25/3 的有界盘点。取消收藏仍须先完成非修改性 live preflight，并由当前第一方页面证据确定请求合同；最小 canary 同时通过接口结果与源收藏夹回读后，才能分批处理剩余成员关系。

批量清理只走本地服务的认证 API 执行入口。若 Chrome 登录态未同步或接口回读失败，保存精确错误并停止；不得退化为内置浏览器或长时间逐条点击。

## 新平台接入

在同一个全局 Skill 内新增一个 Adapter 和一份平台参考，不复制核心状态机。Adapter 必须实现：

- 规范化 URL；
- 登录态和能力 preflight；
- 有边界的集合清单；
- 冻结 URL 清单与接收任务交接；
- 多重归属映射；
- 可选状态修改及复核；
- 最终集合边界复核。

每个平台先做小规模真实 canary；通过后才允许全量运行。

## 离线验收

```powershell
node "$env:USERPROFILE/.codex/skills/archive-social-reading/scripts/offline-check.mjs" `
  --project-root "<workflow-root>" `
  --receipt "<workflow-root>\imports\social-reading-archive\phase-1-2026-08-14\validation.json"
```

该验收只读取历史回执并运行合成测试，不访问浏览器、不写阅读区、不改变账号状态。
