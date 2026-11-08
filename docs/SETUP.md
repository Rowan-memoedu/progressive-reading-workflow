# 安装与兼容性

## 基础环境

Node.js 24 或更新版本；首次运行 `npm ci`，随后 `npm run app`。常规网页提取和原文直接导入不要求 Python、Obsidian 或额外视频工具。

`npm test` 执行合成材料回归；`document-core:adapters` 和 `document-core:handoff` 另外需要 ObsidianLocalIR 源码。将 `LOCAL_IR_OBSIDIAN_SOURCE` 设置为其仓库目录，跨入口快照检查可用 `OBSIDIAN_LOCAL_IR_SOURCE` 指定其中的 `main.ts`。

## 生产者

标准处理读取本机 `AI_PRODUCER_*` 设置。可选择已配置的 Codex CLI 或兼容 API 生产者；具体参数、请求合同和诊断见 [标准预处理](../standard-preprocessing/README.md)。API Key 只放在环境变量或忽略的本机配置，不写入请求示例、源码或 Git。

## Python 文档提取

使用 Python 3.11 或更新版本的独立虚拟环境，执行：

```powershell
python -m pip install -r rich-text-import/requirements.txt
$env:PYTHONPATH = (Join-Path (Get-Location) 'rich-text-import/src')
python -m unittest discover -s rich-text-import/tests -p 'test_*.py'
```

PDF/Word 使用相应解析依赖；扫描 PDF 的 MinerU、完整书籍额外编排、视频截图与本机通知均为可选集成，不阻塞网页原文模式。视频上游代码通过 `video-workflow/fetch-public.py code` 按固定提交与哈希取得并核验；遵循附带许可证。调用外部工具前检查其本机环境，不将缺少工具解释为已完成。

## 本机路径

数据根目录可设 `PROGRESSIVE_READING_DATA_HOME`，产物根目录可设 `PROGRESSIVE_READING_ARTIFACT_HOME`。既有 Windows D 盘安装保留 `D:/AppData` 和 `D:/Artifacts`；其他安装回退到系统用户数据目录。

专用覆盖项仍有效：`PROGRESSIVE_READING_WORKFLOW_ROOT`、`PROGRESSIVE_READING_APP_PORT`、`PROGRESSIVE_READING_SUBSCRIPTIONS_HOME`、`RSS_IMPORT_HOME`、`PROGRESSIVE_READING_COOKIE_DATA_ROOT` 和 `PROGRESSIVE_READING_COOKIE_SNAPSHOT_PATH`。旧订阅 active marker 和旧 sidecar 路径保留读取兼容。

部分历史 Windows 管理脚本、可选视频渲染与真实 Canary 仍采用显式 D 盘工具/产物路径。使用前传入其支持的路径参数或环境变量；这些可选脚本不属于跨平台已验收范围。

## 私人数据

新克隆不包含既有订阅、Cookie、阅读正文、批注、恢复记录或安装回执。复制 `.env.example` 时按需填写，保持 `.env` 忽略规则。旧本机文件不必为公开源码迁移或删除。

任何真实导入、取消点赞、安装计划任务或 RemNote 写入都须由调用者显式发起。源码与合成测试不自动执行这些操作。
