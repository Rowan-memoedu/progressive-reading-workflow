# 网络内容导入最小接入包

网络来源工程继续负责抓取、转 Markdown 和来源元数据；不要复制清洗、导读或锚点逻辑。

```js
import { preprocessNetworkMarkdown } from "../standard-preprocessing/integrations/network-import.mjs";

const run = await preprocessNetworkMarkdown({
  markdown: rawMarkdown,
  sourceType: "web_article_markdown",
  sourceMetadata,
  userInstruction: "",
  outputDir: auditRunDir,
  publishPath: finalMarkdownPath,
  assetSourceDir
});

if (!(["completed", "idempotent_replay"].includes(run.result.status)
  && run.result.processing_state === "rendered"
  && run.result.artifacts.target_zone === "local-ir-reading")) {
  // 保留 result.json，按 target_zone 路由；不得把降级或隔离结果写入正常阅读区。
}
```

视频字幕或 ASR Markdown 调用同一函数并设置 `spoken: true`。这会启用完整覆盖、无时间码、书面结构、详细洞察和真实锚点规则。

CLI 等价调用：

```powershell
pr-preprocess --json validate --request request.json
pr-preprocess --json run --request request.json --output .\imports\preprocess-runs\web\<material-id> --publish ".\阅读区\网络内容\<title>.md" --strict
```

`--output` 始终是 `imports` 下的审计目录；最终阅读文件由 `--publish` 直接写成分类目录下的同级 `.md`。不要把运行目录放进阅读区。
