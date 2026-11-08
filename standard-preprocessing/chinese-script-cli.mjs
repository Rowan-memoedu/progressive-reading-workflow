#!/usr/bin/env node
// One deterministic projection shared with non-JavaScript publishers.
import { simplifyPublishedChinese, simplifyChineseText } from "./lib/chinese-script.mjs";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
process.stdout.write(JSON.stringify(Array.isArray(request.texts)
  ? { texts: request.texts.map(simplifyChineseText), engine: "opencc-js/t2s" }
  : simplifyPublishedChinese(request.markdown)));
