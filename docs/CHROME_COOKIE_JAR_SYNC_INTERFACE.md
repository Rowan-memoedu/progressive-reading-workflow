# Chrome Cookie Jar 同步接口 v1

> 历史兼容合同：下文记录已退役的运行时 Jar 替换接口，默认拒绝。现役方案由独立扩展向固定本地端点推送 `local.chrome-cookie-snapshot` v1，消费者从专用凭据文件热更新并在重启后恢复；见 [Chrome 登录态同步](CHROME_LOGIN_SYNC.md) 和 [共享衔接层](SHARED_URL_IMPORT_BRIDGE_V1.md)。下文的端口探测与进程内持久性不适用于现役方案。

本合同只覆盖独立凭据同步工具与网络导入后台之间的进程内 Cookie Jar。正式 `browser-highlight-extension` 不使用此接口，也不得恢复 Cookie 权限、Cookie 同步或 broker worker。

## Endpoint 与探测

- Health：`GET http://127.0.0.1:{port}/api/highlights/health`
- Sync：`POST http://127.0.0.1:{port}/api/browser-import/cookies/sync`
- 端口范围：`37829-37849`
- Sync 只接受 loopback 连接。
- 新合同只接受严格匹配 `chrome-extension://<32 个 a-p 字符>` 的 `Origin`。
- `Content-Type` 必须为 `application/json` 或 `application/json; charset=utf-8`。
- 最大请求体：`33554432` bytes。
- 最大 Cookie 数：`50000`。
- 单次请求为原子全量替换：任一非跳过条目校验失败时，当前 Jar 保持不变。当前限制已覆盖合理的大体量本地 Cookie 集，不提供非原子分批追加。

Health 中的接入字段：

```json
{
  "cookieSync": {
    "endpoint": "/api/browser-import/cookies/sync",
    "schema": "local-ir.chrome-cookie-jar-sync/v1",
    "origin": "chrome-extension://<32-char-extension-id>",
    "maxCookies": 50000,
    "maxBodyBytes": 33554432,
    "atomicReplace": true,
    "partitionedCookies": "skipped_and_counted",
    "persistence": "current_service_process",
    "resyncRequiredAfterRestart": true
  }
}
```

## 请求合同

根对象只允许 `schema` 与 `cookies`：

```json
{
  "schema": "local-ir.chrome-cookie-jar-sync/v1",
  "cookies": [
    {
      "name": "<string>",
      "value": "<string>",
      "domain": ".example.com",
      "hostOnly": false,
      "path": "/",
      "secure": true,
      "httpOnly": true,
      "sameSite": "lax",
      "session": false,
      "expirationDate": 2000000000,
      "storeId": "0",
      "partitionKey": null
    }
  ]
}
```

每条 Cookie 必须显式提供：`name`、`value`、`domain`、`hostOnly`、`path`、`secure`、`httpOnly`、`sameSite`、`session`、`expirationDate`、`storeId`。`partitionKey` 可选；建议同步工具总是显式发送 `null` 或 Chrome 返回的原对象。

- `sameSite` 仅允许 `no_restriction | lax | strict | unspecified`。
- session Cookie 必须发送 `expirationDate: null`；非 session Cookie 必须发送有限的正数 Unix 秒时间戳。
- 含 `partitionKey` 的 Cookie 不进入 Jar，计入 `skipped_partitioned_count`。
- 同步时已过期的 Cookie 不进入 Jar，计入 `skipped_expired_count`。
- 同一 `storeId + domain + path + name` 不得重复。
- 不接受未知根字段或未知 Cookie 字段。

## 成功回执

响应不包含 Cookie 名称、值、域列表或路径，只包含数量与不可逆指纹：

```json
{
  "status": "synchronized",
  "schema": "local-ir.chrome-cookie-jar-sync/v1",
  "cookie_count": 1200,
  "domain_count": 84,
  "skipped_count": 7,
  "skipped_partitioned_count": 5,
  "skipped_expired_count": 2,
  "fingerprint": "sha256:<64 lowercase hex>",
  "persistence": {
    "scope": "current_service_process",
    "resync_required_after_restart": true
  },
  "cookie_values_exposed": false
}
```

Health 的 `cookieSync.state` 使用同样的安全汇总字段。服务重启后 Jar 回到 `configured: false`、`cookie_count: 0`。

## 发送规则

网络导入对每一个请求 URL 重新从 Jar 生成 Cookie header：

- hostOnly Cookie 只匹配完全相同的 hostname。
- domain Cookie 匹配本域及其子域，不做反向或相邻后缀匹配。
- path 使用 RFC 6265 风格的边界匹配；更长 path 优先。
- Secure Cookie 只用于 HTTPS。
- 已过期 Cookie 不发送。
- 重定向后的 URL 重新执行完整匹配，绝不沿用前一 hostname 的 Cookie header。
- HttpOnly 与 SameSite 属性被保留；后台直连没有浏览器站点上下文，SameSite 不作为跨域复用许可。
- 生成的单个 Cookie header 超过 `65536` bytes 时请求失败，不静默截断。

## 旧环境变量兼容

`PROGRESSIVE_READING_URL_COOKIE_MAP_JSON` 与 `local-ir.url-cookie-sync/v1` 仅保留为精确 hostname 的兼容回退，不是全部 Cookie 同步主路径。旧合同只能从 `progressive-reading-setup://local` Origin 调用；新 Chrome Jar 合同不能使用该 Origin。
