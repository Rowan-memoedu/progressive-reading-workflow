# RSS/Atom 来源导入 v1

状态：`1.2.0 / released`

该工程只负责 RSS/Atom 来源获取与原始材料保真落盘。它不生成导读卡，不翻译，不做阅读价值判断，不写 `阅读区/`、RemNote 或 Logseq，也不使用 Chrome、Cookie 或登录态。

## 稳定入口

```powershell
npm run rss:source:discover -- --url <website-url>
npm run rss:source:validate -- --feed-url <feed-url>
npm run rss:source:sync:v1 -- --feed-url <feed-url> --limit 3
npm run rss:source:sync:v1 -- --feed-url <feed-url> --fetch-fulltext --user-instruction "<用户指令>"
npm run rss:source:subscriptions
npm run rss:source:sync:all -- --limit 3
npm run rss:source:sync:all -- --force
npm run rss:source:check
```

`discover` 和 `validate` 只读网络，不写项目文件。`sync` 默认写入 `imports/rss/source-v1/`。CLI 拒绝把输出目录指向渐进阅读工程之外。

首个公开 canary 使用 `--limit 3`；只有明确的正常同步才省略 limit。允许范围为 1–100，`0` 仅表示内部默认的不限制模式。

正常增量同步继续使用 ETag / Last-Modified。只有订阅配置或全文补抓策略改变、需要重新检查既有条目时才使用 `--force`；它跳过本轮条件请求，但不绕过去重或来源合同。

来源保真：RSS HTML 与网页导入复用同一富文本转换器，保留标题、链接、强调、列表、表格、代码、图片和公式。已知简化 RSS 原文页通过来源适配器读取公开的原始 Markdown，并保存原始响应作为证据。格式获取机制升级时沿用原材料 ID，将新正文和预处理请求保存为不可变修订，保留旧请求供现有阅读稿及批注核对。

## 订阅注册表与批量同步

唯一订阅输入为 `D:/AppData/RSSImport/RSS 自动导入.md` 的第三个区域“日报与周报”；旧 JSON 订阅输入已移除。第一、二区分别供标准导入与原文导入使用，不由本模块同步。读取文档后在内存中生成 `progressive-reading.rss-subscriptions/v1` 合同，不另建可编辑清单。Feed 只有摘要时补取公开原文页，受限内容仍保留阻塞状态。当前日报周报维持暂停。

`subscriptions` 只读文档并列出第三类订阅。`sync-all` 顺序同步这些订阅，也可用 `--subscription-id <id>` 限定一个来源；每个 Feed 保留独立运行回执，批次总回执写入 `imports/rss/source-v1/batches/<batch-id>/run.json`。单个 Feed 失败不会丢失其他 Feed 的成功结果。第三个区域留空时，批量同步不会从历史清单补回来源。

受限 `--limit` 运行只有在 limit 已覆盖 Feed 全部条目时才把 `inventory_complete` 标为 true。未覆盖完整库存的 Canary 不启用后续 ETag/Last-Modified 条件请求，避免 HTTP 304 掩盖尚未处理的条目。

## 合同

- 来源包：`progressive-reading.rss-source-package/v1`
- Schema：`contracts/source-package.v1.schema.json`
- 前置交接：`progressive-reading.preprocess.request/v1`
- 同步结果：`progressive-reading.rss-sync-result/v1`

一个新条目包固定包含：

```text
imports/rss/source-v1/
  state.json
  batches/<batch-id>/run.json
  runs/<run-id>/
    raw/feed.rss.xml 或 feed.atom.xml
    raw/response.json
    items.json
    run.json
  packages/<source-id>/<material-id>/
    package.json
    source.md
    source-metadata.json
    preprocess-request.json       # 仅 fulltext_ready
    raw/item.json
    raw/feed-content.txt
    raw/item-page.html            # 仅实际补抓全文时
    raw/item-page-response.json   # 条目页响应证据
```

来源包保存规范化 feed URL、条目 URL、GUID 和内容 SHA-256。持久状态以以下别名识别重复：

- 同一 feed 下的 GUID；
- 规范化条目 URL；
- 同一 feed 下的内容哈希。

材料身份的内容哈希取自 Feed 条目原始内容；公开条目页另作为原始 artifact 保存并保留响应证据，不用页面模板变化制造新身份。Feed 中同一 URL/GUID 的原始内容哈希变化时保留为新材料版本，`previous_material_id` 指向上一版本；内容哈希也相同时记录 `duplicate`。若同一摘要条目因补抓策略改变而获得全文或明确失败，则原 material ID 的包原地迁移为 `fulltext_ready` 或 `fetch_failed`，不会额外制造第二个活动包。

## 摘要与全文状态

- `fulltext_ready`：Feed 明确提供 `content:encoded` / Atom `content`，或公开条目页全文抓取成功。
- `summary_only`：只有摘要且没有可补抓的条目 URL。
- `fetch_required`：只有摘要且有条目 URL；状态迁移会保留在 receipt 中。
- `fetch_failed`：显式请求补抓全文但失败；例如公开页明确只对付费订阅者开放时记录 `fetched_article_access_restricted_paid_subscribers`。
- `duplicate`：本轮命中既有同内容材料；既有 `content_status` 继续保留。

只有 `fulltext_ready` 生成 `preprocess-request.json`。其余状态停留在来源层，绝不能冒充全文进入正常阅读管线。

## 增量与原始保真

- 保存每次真实响应的原始 XML、允许列出的响应头、最终 URL、抓取时间和响应体哈希。
- 保存 ETag 和 Last-Modified；后续同步发送 `If-None-Match` / `If-Modified-Since`。
- HTTP 304 只生成 `not_modified` 运行回执，不重写来源包。
- Windows 原子目录提交遇到短暂 `EPERM` / `EBUSY` / `EACCES` 时做有界退避重试；同 material ID 和内容哈希的现存孤儿包会重新登记进 state，身份冲突仍 fail closed。
- Feed 字段和条目页 HTML 原样保存在 `raw/`；`source.md` 只承担 HTML 到 Markdown 的来源等价转换，不执行通用清洗。

## 前置接口边界

`fulltext_ready` 包生成的请求可直接执行：

```powershell
pr-preprocess --json validate --request <package>/preprocess-request.json
```

后续正式运行和发布由渐进阅读使用平台负责。本工程不调用 `pr-preprocess run`，不决定阅读区目标，也不复制清洗、翻译、洞察、锚点或导读规则。

## 旧系统保全与退役边界

旧系统退役前已运行一次只读审计，读取旧 `state.json`、来源层、运行记录、旧代码和 `阅读区/RSS` 历史输出，生成：

- `imports/rss/legacy-v0/manifest.json`：逐文件路径、大小、SHA-256、处置类别与内容寻址证据；
- `review-decisions.json`：历史筛选决定，不是来源事实，也不是发布授权；
- `migration-candidates.json`：可重新获取的 RSS 候选、阅读区独有 URL 与非 RSS 旧条目。

不可重建证据按哈希保存在 `legacy-v0/evidence/`，重复内容只保存一份。旧原件已在审计、摘要区迁移和 Canary 全部通过后清退；`legacy-v0` 是只读、不可覆盖的退役快照，不再提供日常审计命令。旧 Markdown 无法单独证明全文完整，因此只标记为 `unverified_legacy` / `refetch_required`，不会直接写入 v1 来源包或生成前置请求。

## 发布验证

11 项合成 fixture 已覆盖发现、RSS/Atom 校验、摘要/全文隔离、全文补抓成功与失败、既有摘要包原地升级与失败留证、四重身份记录、条件请求与强制重扫、第二次同步去重、来源包 Schema、订阅注册表、批量降级传播、旧资产保全、决策分离、limit 门禁和前置请求 Schema。

2026-08-22 使用 `https://www.justinmath.com/` 完成 3 条公开 live canary：网站发现 Atom Feed 成功，Feed 10 条均可解析；限定落盘 3 条 `fulltext_ready` 来源包，原始 Feed/Markdown 哈希和 3 份前置请求全部通过验证；第二次同步返回 HTTP 304。验证回执位于 `imports/rss/source-v1/runs/20260822052314-513e9279/live-canary-verification.json`。

同日使用现役注册表完成每源 1 条的 `sync-all` Canary：Justin Math 与 Dan Koe Letters 均成功生成 `fulltext_ready` 来源包，两份 `preprocess-request.json` 均通过本机 `pr-preprocess 1.2.0` 校验；立即重复后 Justin 返回 HTTP 304，Dan Koe 命中 `duplicate`。批次回执分别位于 `imports/rss/source-v1/batches/20260822082308-d9d2cfde/run.json` 与 `imports/rss/source-v1/batches/20260822082324-8388adb8/run.json`。

完整库存 Canary 暴露并修复了 limit 条件请求遗漏和 Windows 原子提交锁两类通用缺陷。修复后 `imports/rss/source-v1/batches/20260822083256-4b0470c4/run.json` 完整覆盖 Justin Math 10 条和 Dan Koe Letters 20 条；当时 30 个来源包中 28 个为 `fulltext_ready`、2 个为 `fetch_required`。紧接的 `20260822083310-6fc70276` 批次两个 Feed 均返回 HTTP 304。

启用 Dan Koe Letters 订阅级补抓后，`imports/rss/source-v1/batches/20260822115843-d11c4623/run.json` 从原始 Feed 对全部 30 条执行无 limit 强制重扫：28 个既有 `fulltext_ready` 未回退且 28 份前置请求全部通过验证；两篇摘要条目的公开页面返回 HTTP 200，但页面明确标记仅付费订阅者可读，因此原 material ID 原地迁移为 `fetch_failed`，保存页面与响应证据，不生成前置请求。批次状态为 `completed_with_failures`，不会把来源级阻塞隐藏成整体成功。

2026-08-23 的最新完整来源批次 `imports/rss/source-v1/batches/20260823130032-452db876/run.json` 再次覆盖两个订阅共 30 条，保持 28 个 `fulltext_ready` 与 2 个付费订阅限制的 `fetch_failed`。RSS 阅读消费者 Canary `imports/rss-reading/canary/20260823-9bd1f7f3/verification.json` 已从该批次重跑通过：28/28 前置请求有效，两条阻塞均有原始页面和响应证据，未产生未经批准的阅读区平铺长文。

旧资产真实审计共纳入 254 个文件，以 173 个唯一内容块保全 251 个不可重建文件；确认 16 条唯一 RSS 候选、4 份重复来源文件、15 条非 RSS 条目、14 条已选择和 8 条未决决定、17 条阅读区独有 URL。回执位于 `imports/rss/legacy-v0/manifest.json`。

发布清单见 `release.json`。回滚时停止调用 `rss:source:sync:all`，保留 `imports/rss/source-v1/` 与 `imports/rss/legacy-v0/` 审计数据。旧脚本、旧运行层和旧阅读子目录已按清退回执删除；未来正式发布目标仍保留为 `阅读区/RSS` 根目录。
