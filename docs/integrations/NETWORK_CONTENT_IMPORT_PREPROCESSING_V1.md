# 网络内容导入工程｜标准前置处理接入包 v1


## 保持不变

- 继续当前 canary，不等待本接口。
- 继续负责 URL/API/来源工具调用、抓取失败和平台特有处理。
- 继续产出原始 Markdown 与来源元数据。

## 未来替换点

仅替换来源任务中“原始 Markdown → 最终标准阅读 Markdown”的本地处理步骤。不要把抓取、登录、验证码、浏览器或平台鉴权传给本接口。

最小 request 映射：

```json
{
  "schema_version": "progressive-reading.preprocess.request/v1",
  "contract_version": "1.0.0",
  "material": { "markdown": "<raw_markdown>" },
  "source_type": "<wechat|web|rss|github_repo|other>",
  "source_metadata": {
    "source_url": "<source_url>",
    "canonical_url": "<canonical_url_or_null>",
    "original_url": "<translation_original_url_or_null>",
    "title": "<title>",
    "author": "<author_or_null>",
    "published_at": "<published_at_or_null>",
    "translation": { "is_translation": false }
  },
  "user_instruction": "<user_instruction_or_empty_string>"
}
```

接入顺序：

1. 先 shadow 调用：保留现有 canary 产物，同时保存本接口 `result.json`，不替换最终文件。
2. 比较 `status`、正文覆盖、来源链接、前置卡、真实 block 跳转和 receipt。
3. 只有该来源的合成/公开 canary 通过后，才把正常读取改为 `artifacts.reading_markdown`。
4. `quarantined` 写入译文隔离区；`failed` 不覆盖现有产物；`completed_with_warnings` 保留警告并按来源策略决定是否进入待审区。

视频字幕在来源侧先确定性转换为无时间码的来源保真 Markdown，再调用接口。建议使用：

```json
{
  "source_type": "youtube_video_transcript",
  "processing_options": {
    "cleaning_mode": "source_voice_structuring",
    "preserve_source_voice": true,
    "forbid_visible_timestamps": true,
    "require_content_headings": true,
    "attribute_unverified_claims": true
  }
}
```

时间码、字幕下载记录和原始 VTT 只留在来源审计层，不进入最终阅读 Markdown。`attribute_unverified_claims` 只约束导读洞察明确标注材料主张，不把正文改成第三人称转述。

验收命令：

```powershell
npm run preprocess -- --request <request.json> --output <shadow-run-dir> --json
```
