import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import core from "./index.mjs";
if (!process.env.LOCAL_IR_OBSIDIAN_SOURCE) throw new Error("Set LOCAL_IR_OBSIDIAN_SOURCE to the Obsidian plugin source directory for handoff integration tests.");
const { host, plain } = await import(pathToFileURL(process.env.LOCAL_IR_OBSIDIAN_SOURCE + "/test/document-core-host.mjs"));
const artifacts = process.env.LOCAL_IR_TEST_ARTIFACTS || "D:/Artifacts/local-ir-document-core";
await fs.mkdir(artifacts, { recursive: true });
const isolated = await fs.mkdtemp(path.join(artifacts, "handoff-"));
const root = path.join(isolated, "04 Projects", "渐进阅读工作流");
await fs.mkdir(path.join(root, "config"), { recursive: true });
await fs.copyFile(new URL("../config/import-destination-routes.json", import.meta.url), path.join(root, "config/import-destination-routes.json"));
const port = Number(process.env.LOCAL_IR_HANDOFF_PORT || 39347);
const probe = net.createServer();
await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
await new Promise(resolve => probe.close(resolve));
const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/progressive-reading-app.mjs", import.meta.url))], {
  env: { ...process.env, PROGRESSIVE_READING_WORKFLOW_ROOT: root, PROGRESSIVE_READING_APP_PORT: String(port), PROGRESSIVE_READING_WRITE_SERVER_INFO: "false" }, windowsHide: true });
let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
try {
  let ready = false;
  for (let i = 0; i < 400; i++) {
    if (child.exitCode !== null) throw new Error(output);
    // Only this child's successful listen callback permits requests. A competing
    // binder after the preflight causes the child to exit, never a foreign POST.
    if (output.includes(`Progressive reading app: http://127.0.0.1:${port}`)) {
      const response = await fetch(`http://127.0.0.1:${port}/api/highlights/health`);
      if (response.ok && (await response.json()).service === "local-ir-browser-highlight") { ready = true; break; }
    }
    if (i % 50 === 0) console.log("Waiting for isolated service startup...");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, output);
  const body = "Alpha selected sentence. The gap must remain unhighlighted. Beta selected sentence. Additional neutral synthetic prose for local article conversion.";
  const selected = ["Alpha selected sentence.", "Beta selected sentence."];
  let draft = core.createDraft({ id: "handoff-fixture", url: "https://local.test/core-handoff", title: "Shared document core fixture", pageText: body, sourceText: body,
    html: `<html><body><article><h1>Shared document core fixture</h1><p>${body}</p></article></body></html>`,
    annotations: selected.map((text, i) => ({ id: `source-${i}`, selectedText: text, originalText: text,
      ranges: [{ start: body.indexOf(text), end: body.indexOf(text) + text.length }],
      commentMarkdown: `comment ${i}`, rewriteMarkdown: `rewrite ${i}`, type: i ? "rewrite" : "comment", customField: { i }, headingPath: ["Fixture"] })),
    articleMusing: { id: "musing", bodyMarkdown: "Musing preserved" }, qaCards: [{ id: "qa", questionMarkdown: "Question preserved?", answerMarkdown: "Yes" }] });
  draft = core.mergeAnnotations(draft, ["source-1", "source-0"]).draft;
  const response = await fetch(`http://127.0.0.1:${port}/api/highlights/commit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft }) });
  const receipt = await response.json(); assert.equal(response.status, 200, JSON.stringify(receipt));
  assert.equal(receipt.status, "saved_locked");
  for (const artifact of receipt.artifacts) assert.ok(path.resolve(artifact.path).startsWith(path.resolve(isolated) + path.sep));
  const markdownFile = receipt.artifacts.find(item => item.kind === "markdown").path;
  const sidecarFile = receipt.artifacts.find(item => item.kind === "browser_ir_metadata").path;
  const markdown = await fs.readFile(markdownFile, "utf8");
  const state = JSON.parse(await fs.readFile(sidecarFile, "utf8"));
  const record = state.annotations[0];
  assert.deepEqual(record.virtualRanges.map(range => markdown.slice(range.start, range.end)), selected);
  assert.equal(record.commentMarkdown, "comment 0\n\ncomment 1");
  assert.equal(record.rewriteMarkdown, "rewrite 0\n\nrewrite 1");
  assert.deepEqual(record.mergedSources, draft.annotations[0].mergedSources);
  const { plugin } = host([], markdown, state.document.path);
  plugin.app.vault = { adapter: { read: async name => name === "fixture.sidecar" ? await fs.readFile(sidecarFile, "utf8") : markdown } };
  assert.equal(await plugin.importDocumentStateSidecarPath(state.document.path, "fixture.sidecar", markdown), true);
  assert.deepEqual(plain(plugin.settings.annotations[record.id].virtualRanges), record.virtualRanges);
  assert.deepEqual(plain(plugin.settings.annotations[record.id].mergedSources), record.mergedSources);
  assert.equal(plugin.settings.annotations[record.id].commentMarkdown, record.commentMarkdown);
  assert.equal(plugin.settings.annotations[record.id].rewriteMarkdown, record.rewriteMarkdown);
  assert.equal(plugin.settings.qaCards.qa.answerMarkdown, "Yes");
  assert.equal(plugin.settings.articleMusings[state.document.path].bodyMarkdown, "Musing preserved");
  await fs.writeFile(path.join(isolated, "receipt.json"), JSON.stringify({ status: "passed", receipt, checks: ["HTTP commit", "disk readback", "discrete ranges", "all comments and rewrites", "source provenance", "real Obsidian sidecar import", "QA and musing"] }, null, 2));
  console.log("PASS browser -> isolated save service -> real Obsidian import: " + isolated);
} finally {
  child.kill();
  if (child.exitCode === null) await once(child, "exit");
  await fs.writeFile(path.join(isolated, "server.log"), output);
}
