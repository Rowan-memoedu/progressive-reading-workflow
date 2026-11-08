# 浏览器采集与初始高亮｜标准前置处理接入包 v1


## 保持不变

- 继续当前 canary，不等待本接口。
- 继续负责页面采集、可读正文提取、初始高亮来源坐标和浏览器特有证据。
- 继续产出原始 Markdown 与来源元数据；页面 DOM、Cookie、登录态和可见浏览器状态不得传给外部 AI。

## 未来替换点

仅替换“采集完成的原始 Markdown → 最终标准阅读 Markdown”。浏览器采集的高亮/坐标若需要保留，应作为 `source_metadata.capture` 的结构化来源证据传入，但 v1 不承诺把 DOM 坐标转换成 Local IR 高亮记录。

最小 request 映射：

```json
{
  "schema_version": "progressive-reading.preprocess.request/v1",
  "contract_version": "1.0.0",
  "material": { "markdown": "<captured_markdown>" },
  "source_type": "browser_capture",
  "source_metadata": {
    "source_url": "<page_url>",
    "canonical_url": "<canonical_url_or_null>",
    "title": "<page_title>",
    "captured_at": "<timestamp>",
    "capture": {
      "method": "<readability|selection|page_markdown>",
      "source_evidence_id": "<local_receipt_id>"
    }
  },
  "user_instruction": "<user_instruction_or_empty_string>"
}
```

接入顺序：

1. 先 shadow 调用，现有 canary 继续完成。
2. 核验原始链接、正文块覆盖、代码块/引用保真、三个置顶判断和洞察跳转。
3. 不把模型生成的块 key 当成浏览器坐标；Local IR 最终锚点只认 `artifacts.body_blocks[].block_id`。
4. `failed` 不覆盖采集产物；`quarantined` 进入译文隔离区；正常结果才增量替换旧标准处理输出。

验收命令：

```powershell
npm run preprocess -- --request <request.json> --output <shadow-run-dir> --json
```

