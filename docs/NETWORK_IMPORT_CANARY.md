# 网络视频字幕 Canary

该独立 Canary 用于验证“浏览器分组中的 YouTube 视频 -> 去重 -> 字幕分流 -> 阅读区格式编辑 -> 可审计本地产物”，产物保存在隔离目录。2026-09-19 已恢复共享服务的 YouTube 字幕正式入口，直接复用本文件所述脚本的 VTT 解析与分段函数，再调用现役标准预处理；当前能力及实测状态见[视频导入工作流状态](VIDEO_WORKFLOW_STATUS.md)。

## 2026-08-14 架构记录（历史）

- 当前 Canary、来源采集、来源验证、原始 Markdown/VTT 落盘和用户验收继续推进，不因独立接口暂停。
- 只有“原始 Markdown -> 最终标准阅读 Markdown”这一处理步骤未来改为调用独立接口。
- 当时接口尚未发布版本化合同与合成 fixture，因此 Canary 使用已经验证的本地兼容路径。
- 代码中的唯一未来替换点是 `processStandardMarkdown()`；新接口稳定后只增量替换该调用，不回退采集层，不撤销已有产物，也不把接口内部处理逻辑复制回来源工程。

以下输入、质量门禁和运行参数适用于保留的独立 Canary CLI。

## 输入

- `network-import-request/v1`
- `source_type: browser_tab_group_video`
- `material.browser_group` 和 `input.tabs`
- 用户原始要求保存在 `user_instruction`

## 质量门禁

- 默认只允许 1 个唯一来源；超过 1 个时直接拒绝，防止在用户审批样本前误跑批量。
- 只接受 YouTube 人工上传的 `zh-Hans` 字幕。
- 无字幕时记录 `no_acceptable_subtitle`，不自动转 ASR。
- 所有 Markdown 均为 `staged_needs_review`，不伪装成已验收阅读材料。
- 字幕只是原始层，不得直接作为阅读区正文。必须调用结构化编辑，把口语、重复和字幕切分整理为书面文本。
- 正文前必须包含现有阅读区合同的 `阅读前置卡`：一句话核心、核心洞见、对我的价值判断、信息密度判断、能解决我的什么痛点、具体用处、是否急需阅读。
- 最终阅读稿完全不出现时间戳。时间信息只保存在原始 VTT 审计层，不进入标题、段落、括号或来源说明。
- 正文必须使用内容型层级标题，只做断句、去冗余、分段和结构组织；不得改成“作者认为”等第三人称转述。
- 正文保留原说话者的第一人称视角、原有立场、判断力度和表达风格；文件级说明统一标注“未做事实核查，不代表编者立场”。
- 结构化编辑失败、前置卡缺节、正文过短、出现时间戳、转成第三人称或仍呈逐字稿形态时，整项失败，不得退化为原始字幕 Markdown。
- 原始 VTT、规范化 Markdown、`receipt.json` 与 `result.json` 保留在隔离目录。

## 运行

```powershell
npm run canary:youtube-subtitles -- --request <request.json> --probe-dir <metadata-and-vtt-dir> --out <output-dir>
```

只有在样本获得审批后，批量执行才可显式加上 `--allow-batch`。

结果必须包含 `status`、`artifacts`、`source_metadata`、`receipt` 和 `errors`。Artifact 类型为 `staged_structured_reading_markdown`；原始字幕只通过 `raw_subtitle_path` 保留用于审计。
