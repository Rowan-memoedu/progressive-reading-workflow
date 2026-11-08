# Chrome Cookie 凭据同步工具

这是一个与正式渐进阅读浏览器插件完全隔离、可长期保留的单一职责 MV3 扩展。它只在用户明确点击“同步全部 Chrome Cookie”后，读取当前常规 Chrome Profile 中扩展有权访问的 HTTP/HTTPS Cookie，并把完整属性原子同步到本机渐进阅读服务的进程内 Cookie Jar。

## 安全边界

- 权限只有 `cookies` 与 `<all_urls>`；加载时 Chrome 会明确提示广泛站点访问权限。
- 不包含 URL 导入、高亮、content script、broker worker、定时器或自动后台同步。
- Cookie 只存在于扩展 Service Worker 的本次调用内存和本地服务当前进程内存中。
- 不写 `chrome.storage`、磁盘、console、Popup 或错误文本；Popup 只显示总条数、域数、跳过数或固定失败提示。
- 分区 Cookie 与已过期 Cookie 由后台跳过并计数；任一其他条目校验失败时，后台保留旧 Jar。
- 本地服务重启后 Cookie Jar 清空，需要再次手动同步。

接口合同见 [Chrome Cookie Jar 同步接口](../../docs/CHROME_COOKIE_JAR_SYNC_INTERFACE.md)。

## 加载与使用

1. 确认渐进阅读本地服务已运行，并在 `37829-37849` 中提供 `local-ir.chrome-cookie-jar-sync/v1` 合同。
2. 在 Chrome 地址栏打开 `chrome://extensions/`。
3. 开启“开发者模式”，点击“加载已解压的扩展程序”。
4. 选择以下精确目录：

   ```text
   <workflow-root>\tools\chrome-cookie-credential-sync
   ```

5. 接受 Chrome 显示的 Cookie 与所有站点权限提示。
6. 打开扩展 Popup，点击“同步全部 Chrome Cookie”。
7. 看到总条数、域数和跳过数即完成；服务重启后重复第 6 步。

扩展不会启动本地服务。服务不可用或合同版本不匹配时只显示固定失败提示。

## 测试

在本目录运行：

```powershell
npm test
```

测试只使用合成 Cookie。安全测试验证无自动读取、无持久化、无日志和无导入/高亮/worker 能力；本地合同测试启动隔离的临时服务进程，执行真实同步接口后删除临时目录，不读取当前 Chrome 的真实 Cookie。

## 停用或删除

- 临时停用：在 `chrome://extensions/` 关闭本扩展。
- 从 Chrome 移除：在扩展卡片上点击“移除”。
- 若不再保留源码，可在移除扩展后删除本目录。
- 停用、移除或删除扩展不会主动清除服务进程内已有 Jar；如需清空，重启渐进阅读本地服务。服务重启本身不会删除任何 Chrome Cookie。
