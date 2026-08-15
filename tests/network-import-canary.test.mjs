import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceCanaryScope,
  groupTranscriptSegments,
  parseVtt,
  uniqueYoutubeInputs,
  validateStructuredReadingBody,
  youtubeVideoId,
} from "../scripts/import-youtube-subtitle-canary.mjs";

test("youtubeVideoId canonicalizes watch and short URLs", () => {
  assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=dBUc-KsKVvs&list=abc"), "dBUc-KsKVvs");
  assert.equal(youtubeVideoId("https://youtu.be/dBUc-KsKVvs"), "dBUc-KsKVvs");
});

test("enforceCanaryScope rejects accidental batch execution", () => {
  assert.throws(
    () => enforceCanaryScope([{ id: "one" }, { id: "two" }]),
    /canary_requires_single_source:received_2/,
  );
  assert.doesNotThrow(() => enforceCanaryScope([{ id: "one" }]));
  assert.doesNotThrow(() => enforceCanaryScope([{ id: "one" }, { id: "two" }], { allowBatch: true }));
});

test("groupTranscriptSegments turns short cues into readable timestamped paragraphs", () => {
  const paragraphs = groupTranscriptSegments([
    { start: "00:00:00", text: "这是第一个很短的字幕片段" },
    { start: "00:00:02", text: "这是第二个字幕片段，继续补充完整意思" },
    { start: "00:00:04", text: "这是第三个字幕片段，并在这里结束这个段落。" },
    { start: "00:00:08", text: "新的段落" },
  ], { minChars: 40, maxChars: 120 });
  assert.deepEqual(paragraphs, [
    {
      start: "00:00:00",
      text: "这是第一个很短的字幕片段这是第二个字幕片段，继续补充完整意思这是第三个字幕片段，并在这里结束这个段落。",
    },
    { start: "00:00:08", text: "新的段落" },
  ]);
});

test("uniqueYoutubeInputs deduplicates playlist variants", () => {
  const inputs = uniqueYoutubeInputs([
    { title: "A", url: "https://www.youtube.com/watch?v=dBUc-KsKVvs&index=3" },
    { title: "A", url: "https://www.youtube.com/watch?v=dBUc-KsKVvs" },
    { title: "B", url: "https://www.youtube.com/watch?v=ZSzrQR16RZ8" },
  ]);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].urls.length, 2);
});

test("parseVtt keeps timestamps and removes markup and adjacent duplicates", () => {
  const segments = parseVtt([
    "WEBVTT",
    "Kind: captions",
    "Language: zh-Hans",
    "",
    "00:00:00.100 --> 00:00:01.000",
    "<c>第一句</c>",
    "",
    "00:00:01.000 --> 00:00:02.000",
    "第一句",
    "",
    "00:00:02.000 --> 00:00:03.000",
    "第二句 &amp; 补充",
  ].join("\n"));
  assert.deepEqual(segments, [
    { start: "00:00:00", text: "第一句" },
    { start: "00:00:02", text: "第二句 & 补充" },
  ]);
});

test("validateStructuredReadingBody enforces the reading-area content contract", () => {
  const body = [
    "<!-- reading-guide:start -->",
    "## 阅读前置卡",
    "### 一句话核心",
    "一句话。",
    "### 核心洞见",
    "- 洞见一",
    "### 对我的价值判断",
    "高。",
    "### 信息密度判断",
    "中。",
    "### 能解决我的什么痛点",
    "- 痛点",
    "### 具体用处",
    "- 用处",
    "### 是否急需阅读",
    "近期。",
    "<!-- reading-guide:end -->",
    "---",
    "## 结构化正文",
    "### 论点一",
    "书面正文".repeat(500),
    "### 论点二",
    "书面正文".repeat(500),
    "### 论点三",
    "书面正文".repeat(500),
    "### 论点四",
    "书面正文".repeat(500),
  ].join("\n");
  assert.doesNotThrow(() => validateStructuredReadingBody(body));
  assert.throws(
    () => validateStructuredReadingBody(`${body}\n### 00:12:00\n逐字稿`),
    /structured_body_contains_timestamps/,
  );
  assert.throws(
    () => validateStructuredReadingBody(body.replace("书面正文", "作者认为，书面正文")),
    /structured_body_shifted_to_third_person/,
  );
});
