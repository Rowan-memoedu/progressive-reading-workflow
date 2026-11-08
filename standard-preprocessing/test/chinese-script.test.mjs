import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { simplifyPublishedChinese } from "../lib/chinese-script.mjs";
import { buildPreprocessRequest, runPreprocessingRequest, standardWorkflowOptions } from "../index.mjs";

test("mechanical simplification covers mixed prose, headings, quotes and tables without changing English", () => {
  const input = "# 臺灣政治\n\nEnglish remains unchanged. 王滬寧與意識形態。\n\n> 引語：國家與社會。\n\n| 題名 | 作者 |\n| --- | --- |\n| 學術論文 | 張三 |\n";
  const output = simplifyPublishedChinese(input);
  assert.equal(output.markdown, "# 台湾政治\n\nEnglish remains unchanged. 王沪宁与意识形态。\n\n> 引语：国家与社会。\n\n| 题名 | 作者 |\n| --- | --- |\n| 学术论文 | 张三 |\n");
  assert.ok(output.report.changed_characters > 0);
  assert.equal(simplifyPublishedChinese(output.markdown).markdown, output.markdown);
});

test("identity metadata, destinations, inline/fenced code and formula literals remain exact", () => {
  const literals = [
    "---\nsource_url: https://example.invalid/論文\nmaterial_id: mat-繁體\n---",
    "`變量`", "``繁體`code``", "[論文](https://example.invalid/論文)",
    "![圖表](assets/圖表.png)", "$\\text{變量}$", "$$\\text{國家}$$", "\\(\\text{國家}\\)", "\\[\\text{國家}\\]", "[ref]: assets/圖表.png",
    "https://example.invalid/繁體", "~~~text\n國家程式碼\n~~~",
    "````text\n繁體\n```\n更多繁體\n````"
  ];
  const input = literals.join("\n\n") + "\n\n正常繁體與簡體。";
  const output = simplifyPublishedChinese(input).markdown;
  for (const item of literals) {
    assert.ok(output.includes(item.replace("[論文]", "[论文]").replace("![圖表]", "![图表]")), item);
  }
  assert.ok(output.endsWith("正常繁体与简体。"));
  assert.match(simplifyPublishedChinese("---\ntitle: 政治學\nsource_id: 繁體\n---\n\n正文").markdown, /title: 政治学\nsource_id: 繁體/);
});

test("wiki file/heading destinations remain literal and visible labels are simplified", () => {
  const input = "[[繁體筆記#章節|閱讀標籤]] 與 [[繁體筆記]]";
  const output = simplifyPublishedChinese(input).markdown;
  assert.equal(output, "[[繁體筆記#章節|阅读标签]] 与 [[繁體筆記|繁体笔记]]");
  assert.equal(simplifyPublishedChinese(output).markdown, output);
});

test("shared publication simplifies a Chinese document without model calls or source mutation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr-script-canary-"));
  const source = "# 歷史研究\n\n作者說：經濟與社會發展，必須保留全部細節。";
  const request = buildPreprocessRequest({
    markdown: source,
    sourceType: "synthetic_script_canary",
    sourceMetadata: {source_url: "https://example.invalid/繁體", source_is_original: true, language: "zh", input_form: "written", content_profile: "natural_language"},
    processingOptions: standardWorkflowOptions({translate: false, include_reading_guide: false})
  });
  const run = await runPreprocessingRequest(request, {outputDir: path.join(root, "run"), publishPath: path.join(root, "阅读.md"), cacheDir: false});
  assert.equal(run.result.status, "completed");
  assert.equal(run.result.receipt.model.calls, 0);
  assert.equal(request.material.markdown, source);
  assert.match(run.result.artifacts.reading_markdown, /作者說/);
  const published = await fs.readFile(run.publication.markdown.path, "utf8");
  assert.match(published, /作者说：经济与社会发展，必须保留全部细节/);
  assert.match(published, /https:\/\/example.invalid\/繁體/);
  assert.ok(run.publication.chinese_script.changed_characters > 0);
});
