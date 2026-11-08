# Chrome 登录态同步与恢复

## 已核实的问题

2026-09-14 初始故障：旧扩展 1.0.0 只在点击时下载一次 Cookie JSON，没有后台同步。旧指针指向已不存在的下载文件，端口 37829 当时未加载 Cookie。现已部署接收服务并恢复真实扩展自动同步，当前证据见下方。

新扩展启用后的 `cookie_sync_request_failed` 实为 `chrome_cookie_name_invalid`：消费者使用了比 Chromium 更严格的名称 token 校验，且带条目编号的错误被通用提示掩盖。现按 Chromium 的名称规则拒绝控制字符、分号及等号，兼容空名称的 value-only Cookie 并拒绝歧义序列化；错误响应仅保留安全原因码，不输出 Cookie 内容。依据：[Chromium ParsedCookie](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/parsed_cookie.cc)。

2026-09-15 复发原因：Bot 后台自动拉起共享服务时，把旧 `cookie-snapshot.path` 提升为显式手动快照参数，关闭了自动接收端。扩展始终启用且持续重试：18:56 起服务暂不可达，18:57 起返回 `cookie_sync_manual_snapshot_mode`；最后成功快照停在 18:55，后续触发 15 分钟保护。现已删除启动器中的旧指针注入；Bot 与直接启动均由同一消费者解析凭据来源。另已修复过期检查对不匹配 Cookie 的网站/路径造成的连带拦截。

## 修复机制

- 独立扩展活动源码：`D:\Projects\ChromeCookieSync`，旧工作区目录保留为历史来源，未删除。
- 手动导出继续可用。自动模式默认关闭，启用后用官方 `chrome.cookies.onChanged` 合并变动，约 1.5 秒后发送完整快照；`chrome.alarms` 每分钟补同步和重试。Chrome 唤醒后台时会补建闹钟。设置持久化，Cookie 不写入扩展 storage。
- 固定接收方：`http://127.0.0.1:37829/api/browser-import/cookies/snapshot`。只接受扩展 `kkhdelnhoaagpbmgicmdljmplodkioop` 的 Origin 和本机连接；不扫描端口，不上传远端，不重新启用已退役的运行时 Jar 接口。
- 接收方复用 `local.chrome-cookie-snapshot` v1 校验，先校验再原子替换。拒绝超过 5 分钟、未来超过 30 秒或乱序的推送。空快照有效，退出和删除会替换旧状态，不能通过合并继续保留旧 Cookie。
- 凭据位置：`D:\AppData\ProgressiveReading\BrowserAuth\chrome-current.json`。目录限制为当前 Windows 用户与 SYSTEM；不进入阅读区、项目、日志、Git、公共文件路由。响应只含条数、时间和状态。
- 服务直接启动也会自行解析路径，无需启动 CMD 注入。顺序：显式环境变量（手动模式）→ 固定持续同步文件 → 旧指针（兼容）。每次请求最多间隔 1 秒检查文件变更，重启可恢复；文件丢失或损坏清空内存中的旧凭据，服务继续提供可诊断状态。
- 持续同步超过 15 分钟未更新时，匹配目标域与路径的 Cookie 不会发送，对应请求需要恢复同步；没有匹配 Cookie 的公开来源可以继续抓取。该检查不表示网站已判定账号退出；网站实际登录失效或要求验证时，仍按网站要求处理。
- Cookie 按目标域、hostOnly、路径、HTTPS 和过期时间匹配，重定向逐跳重新匹配。分区 Cookie 保留在快照中但不发送，状态中计数；依赖额外浏览器状态的网站不保证单靠 Cookie 可抓取。
- 网页每 30 秒刷新同步状态，区分已加载、文件丢失和长期未更新。状态“已同步”不等于网站登录已验证。
- 知乎专栏枚举必须先有该站匹配的 Cookie；缺失时返回 `zhihu_cookie_not_synced`，不再先发匿名请求等待 403。合成列表示例也必须通过合成快照提供 Cookie。
- 启用持续同步后持久记录来源选择；即使固定快照后来丢失，也不会回退到旧下载文件而重新使用旧登录态。

官方依据：[Cookie API](https://developer.chrome.com/docs/extensions/reference/api/cookies)、[alarms 生命周期](https://developer.chrome.com/docs/extensions/reference/api/alarms)。

实际运行状态以本机健康接口和来源返回为准。公开源码不附带私人材料与历史运行回执；合成回归入口见 [安装与兼容性](SETUP.md)。
