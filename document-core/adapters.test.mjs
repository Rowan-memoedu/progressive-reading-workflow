import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import core from "./index.mjs";
import { pathToFileURL } from "node:url";
if (!process.env.LOCAL_IR_OBSIDIAN_SOURCE) throw new Error("Set LOCAL_IR_OBSIDIAN_SOURCE to the Obsidian plugin source directory for adapter integration tests.");
const { host, plain } = await import(pathToFileURL(process.env.LOCAL_IR_OBSIDIAN_SOURCE + "/test/document-core-host.mjs"));
const at = "2026-09-01T00:00:00.000Z";
const text = "Alpha gap Beta tail Gamma";
const record = (id, start, end, extra = {}) => core.normalizeAnnotation({ id, path: "fixture.md", ranges: [{ start, end }],
  selectedText: text.slice(start, end), commentMarkdown: `comment ${id}`, rewriteMarkdown: `rewrite ${id}`,
  headingPath: ["Heading"], scope: "selection", customField: { id }, createdAt: at, updatedAt: at, ...extra });
const a = record("a", 0, 5), b = record("b", 10, 14), c = record("c", 20, 25);
const business = record => plain(Object.fromEntries(["id", "originalText", "currentText", "selectedText", "commentMarkdown", "rewriteMarkdown", "hasRewrite", "fragments", "virtualRanges", "headingPath", "markKind", "customField"].map(key => [key, record[key]])));
const sorted = records => plain(records).sort((a, b) => a.id.localeCompare(b.id));
const draft = records => core.createDraft({ id: "fixture", sourceText: text, pageText: text, annotations: records, articleMusing: { bodyMarkdown: "musing" }, qaCards: [{ id: "qa", questionMarkdown: "q", answerMarkdown: "a", createdAt: at }] });

for (const order of [[a, b], [b, a]]) {
  let browser = draft([...order, c]);
  const { plugin } = host([...order, c], text);
  const before = sorted(browser.annotations);
  browser = core.mergeAnnotations(browser, order.map(item => item.id)).draft;
  await plugin.mergeAnnotations("fixture.md", order.map(item => item.id));
  assert.deepEqual(business(plugin.settings.annotations.a), business(browser.annotations.find(item => item.id === "a")));
  assert.deepEqual(browser.annotations.find(item => item.id === "a").virtualRanges, [{ start: 0, end: 5 }, { start: 10, end: 14 }]);
  assert.equal(browser.annotations.find(item => item.id === "a").commentMarkdown, "comment a\n\ncomment b");
  browser = core.deleteAnnotation(browser, "a"); await plugin.deleteAnnotation("a");
  browser = core.undo(browser).draft; await plugin.undoRecentHighlight();
  browser = core.undo(browser).draft; await plugin.undoRecentHighlight();
  assert.deepEqual(sorted(browser.annotations), before);
  assert.deepEqual(sorted(plugin.settings.annotations ? Object.values(plugin.settings.annotations) : []), before);
  assert.equal(browser.articleMusing.bodyMarkdown, "musing"); assert.equal(browser.qaCards.length, 1);
  assert.equal(plugin.settings.qaCards.qa.questionMarkdown, "q");
  await plugin.redoRecentVirtualHighlight("fixture.md"); await plugin.redoRecentVirtualHighlight("fixture.md");
  assert.equal(plugin.settings.annotations.a, undefined); assert.ok(plugin.settings.annotations.c);
  assert.equal(plugin.events[0], "refresh");
}

// Automatic overlap and same-block candidates keep every source's processing.
for (const reverse of [false, true]) {
  const one = record("one", 0, 12), two = record("two", 14, 20);
  const initial = reverse ? [two, one] : [one, two];
  const incoming = record("new", 8, 16, { commentMarkdown: "", rewriteMarkdown: "", hasRewrite: false });
  const browser = core.addAnnotation(draft(initial), incoming).draft;
  const { plugin, editor, file } = host(initial, text);
  await plugin.highlightSelection(editor, file, false, { fromOffset: 8, toOffset: 16, from: { line: 0, ch: 8 }, to: { line: 0, ch: 16 }, text: text.slice(8, 16) });
  const merged = browser.annotations[0];
  assert.equal(merged.id, "one");
  assert.equal(merged.commentMarkdown, "comment one\n\ncomment two");
  assert.equal(merged.rewriteMarkdown, "rewrite one\n\nrewrite two");
  assert.deepEqual(business(plugin.settings.annotations.one), business(merged));
  await plugin.undoRecentHighlight(); assert.deepEqual(sorted(Object.values(plugin.settings.annotations)), sorted(initial));
}

const merged = core.mergeRecords([a, b, c], ["b", "a"], { at, textForRange: range => text.slice(range.start, range.end) });
assert.deepEqual(core.mergeRecords([b, c, a], ["a", "b"], { at, textForRange: range => text.slice(range.start, range.end) }), merged);
for (const [records, options, error] of [[[a, { ...b, path: "other.md" }], {}, /cross_document/], [[a, { ...b, markKind: "cloze" }], {}, /mark_kind/], [[a, b], { frozen: true }, /frozen/], [[a, { ...b, archived: true }], {}, /frozen/]]) {
  const before = JSON.stringify(records);
  assert.throws(() => core.mergeRecords(records, ["a", "b"], options), error);
  assert.equal(JSON.stringify(records), before);
}
assert.equal(core.deleteRecords([a, b], ["missing"]).change.ids.length, 0);
assert.throws(() => core.applyChange(merged.records.map(item => item.id === "a" ? { ...item, commentMarkdown: "new edit" } : item), merged.change, "backward"), /stale/);
const unrelatedEdit = { ...c, commentMarkdown: "unrelated edit" };
const restored = core.applyChange(merged.records.map(item => item.id === "c" ? unrelatedEdit : item), merged.change, "backward");
assert.deepEqual(restored.find(item => item.id === "c"), unrelatedEdit);
const adjacent = core.addRecord([a], record("adjacent", 5, 10)); assert.equal(adjacent.records.length, 2);
const anchored = core.anchorAnnotationsToMarkdown([merged.annotation], "prefix\n" + text, "target.md")[0];
assert.equal(anchored.virtualRanges.length, 2);
assert.deepEqual(anchored.virtualRanges.map(range => ("prefix\n" + text).slice(range.start, range.end)), ["Alpha", "Beta"]);
assert.equal(anchored.commentMarkdown, merged.annotation.commentMarkdown);
assert.equal(core.anchorAnnotationsToMarkdown([merged.annotation], "Alpha missing", "target.md")[0].orphaned, true);
const legacy = core.normalizeDocumentState({ schema_version: 1, draft_id: "legacy", annotations: [anchored] }, { path: "target.md" });
assert.deepEqual(core.normalizeDocumentState(JSON.parse(JSON.stringify(legacy))), legacy);
const staleHost = host([a, b], text); await staleHost.plugin.mergeAnnotations("fixture.md", ["a", "b"]);
staleHost.plugin.settings.annotations.a.commentMarkdown = "edited after merge";
await staleHost.plugin.undoRecentHighlight(); assert.equal(staleHost.plugin.settings.annotations.a.commentMarkdown, "edited after merge"); assert.equal(staleHost.plugin.recentHighlightActions.length, 1);
const frozenHost = host([a, b], text); frozenHost.plugin.isRecordFrozenForExport = () => true;
await frozenHost.plugin.mergeAnnotations("fixture.md", ["a", "b"]); await frozenHost.plugin.deleteAnnotation("a");
assert.deepEqual(sorted(Object.values(frozenHost.plugin.settings.annotations)), sorted([a, b]));
const source = await fs.readFile(new URL("core.js", import.meta.url), "utf8");
const mappedHost = host([a], text);
const clearedHost = host([{ ...a, virtualRanges: [] }], text);
assert.deepEqual(plain(clearedHost.plugin.getVirtualAnnotationRangesForPath("fixture.md")), []);
mappedHost.plugin.mapVirtualRangesForEditorChange("fixture.md", { changes: { mapPos: value => value + 7 }, state: { doc: { toString: () => "prefix\n" + text } } });
clearTimeout(mappedHost.plugin.virtualRangeSaveTimer);
const mappedSidecar = core.createDocumentState({ annotations: Object.values(mappedHost.plugin.settings.annotations) }, { path: "fixture.md" });
assert.deepEqual(mappedSidecar.annotations[0].ranges, [{ start: 7, end: 12 }]);
assert.deepEqual(mappedSidecar.annotations[0].virtualRanges, [{ start: 7, end: 12 }]);
assert.equal(mappedSidecar.annotations[0].sourceOffset, 7);
// Host rejection paths must be no-ops, including no persistence or Markdown edit.
for (const pair of [[a, { ...b, path: "other.md" }], [a, { ...b, markKind: "cloze" }], [a, { ...b, archived: true }]]) {
  const { plugin } = host(pair, text);
  await plugin.mergeAnnotations("fixture.md", ["a", "b"]);
  assert.deepEqual(sorted(Object.values(plugin.settings.annotations)), sorted(pair));
  assert.equal(plugin.events.length, 0);
}
const missing = host([a], text); await missing.plugin.deleteAnnotation("missing"); assert.equal(missing.plugin.events.length, 0);
const changedBody = host([a, b], text); await changedBody.plugin.mergeAnnotations("fixture.md", ["a", "b"]);
changedBody.setContent(text + " edited"); await changedBody.plugin.undoRecentHighlight();
assert.ok(changedBody.plugin.settings.annotations.a); assert.equal(changedBody.plugin.settings.annotations.b, undefined);
assert.equal(changedBody.plugin.recentHighlightActions.length, 1);
const currentDocument = host([a, b], text); await currentDocument.plugin.mergeAnnotations("fixture.md", ["a", "b"]);
currentDocument.plugin.app.workspace.getActiveFile = () => ({ path: "other.md" }); await currentDocument.plugin.undoRecentHighlight();
assert.equal(currentDocument.plugin.recentHighlightActions.length, 1);
const sameBlock = host([a, b], text); sameBlock.plugin.settings.autoMergeHighlightsEnabled = true;
await sameBlock.plugin.highlightSelection(sameBlock.editor, sameBlock.file, false, { fromOffset: 20, toOffset: 25, from: { line: 0, ch: 20 }, to: { line: 0, ch: 25 }, text: text.slice(20, 25) });
assert.equal(Object.keys(sameBlock.plugin.settings.annotations).length, 1);
assert.equal(sameBlock.plugin.settings.annotations.a.commentMarkdown, "comment a\n\ncomment b");
assert.equal(sameBlock.plugin.settings.annotations.a.virtualRanges.length, 3);
assert.equal(sameBlock.editor.getValue(), text);
const newEarliest = host([b], text);
await newEarliest.plugin.highlightSelection(newEarliest.editor, newEarliest.file, false, { fromOffset: 8, toOffset: 12, from: { line: 0, ch: 8 }, to: { line: 0, ch: 12 }, text: text.slice(8, 12) });
const earliestRecord = Object.values(newEarliest.plugin.settings.annotations)[0];
assert.notEqual(earliestRecord.id, "b"); assert.equal(earliestRecord.virtualRanges[0].start, 8);
assert.equal(earliestRecord.commentMarkdown, "comment b");
await newEarliest.plugin.undoRecentHighlight(); assert.deepEqual(sorted(Object.values(newEarliest.plugin.settings.annotations)), [b]);
const facade = await fs.readFile(new URL("../browser-highlight-extension/draft-core.js", import.meta.url), "utf8");
assert.equal(facade, source);
const sandbox = {}; vm.runInNewContext(facade, sandbox); assert.equal(typeof sandbox.LocalIrDraftCore.mergeRecords, "function");
console.log("PASS shared core + real Obsidian methods: manual/automatic merge, delete, undo/redo, stale/frozen, unrelated state, fragments, legacy, classic facade");
