# 浏览器采集最小接入包

浏览器任务继续负责页面读取、初始高亮、原始 Markdown 和来源元数据；不要在浏览器链路中实现清洗、导读或锚点规则。

```js
import { preprocessBrowserCapture } from "../standard-preprocessing/integrations/browser-capture.mjs";

const run = await preprocessBrowserCapture({
  markdown: rawMarkdown,
  sourceMetadata: {
    source_url: pageUrl,
    canonical_url: canonicalUrl,
    title,
    author,
    source_is_original: true
  },
  userInstruction: "",
  outputDir: auditRunDir,
  publishPath: finalMarkdownPath,
  assetSourceDir
});

const ready = ["completed", "idempotent_replay"].includes(run.result.status)
  && run.result.processing_state === "rendered"
  && run.result.artifacts.target_zone === "local-ir-reading";
```

只有 `ready` 为真且 `run.publication.status == "published"` 时，`publishPath` 指定的平铺 `.md` 才可交给 Local IR；其他状态按 `target_zone` 保留在 `imports` 审计目录并等待处理。不得把审计目录或其中的 `reading.md` 直接放进阅读区。
