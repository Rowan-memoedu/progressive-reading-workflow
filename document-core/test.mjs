// Dependency-free API tests: no Obsidian checkout or toolchain.
import assert from "node:assert/strict";
import core from "./index.mjs";
const text = "Alpha gap Beta tail Gamma";
const at = "2026-09-01T00:00:00.000Z";
const record = (id, start, end, extra = {}) => core.normalizeAnnotation({ id, path: "fixture.md", ranges: [{ start, end }],
  selectedText: text.slice(start, end), commentMarkdown: `comment ${id}`, rewriteMarkdown: `rewrite ${id}`,
  headingPath: ["Heading"], customField: { id }, createdAt: at, updatedAt: at, ...extra });
const a = record("a", 0, 5), b = record("b", 10, 14), c = record("c", 20, 25);
const sorted = records => [...records].sort((a, b) => a.id.localeCompare(b.id));
const options = { at, textForRange: range => text.slice(range.start, range.end) };
const expected = core.mergeRecords([a, b, c], ["a", "b"], options);
for (const records of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) {
  for (const ids of [["a", "b"], ["b", "a"]]) {
    const result = core.mergeRecords(records, ids, options);
    assert.deepEqual(result, expected);
    assert.equal(result.annotation.commentMarkdown, "comment a\n\ncomment b");
    assert.equal(result.annotation.rewriteMarkdown, "rewrite a\n\nrewrite b");
    assert.equal(result.annotation.currentText, "Alpha\n\nBeta");
    assert.deepEqual(result.annotation.mergedSources, [a, b]);
    const deletion = core.deleteRecords(result.records, ["a"]);
    const restoredMerge = core.applyChange(deletion.records, deletion.change, "backward");
    assert.deepEqual(sorted(core.applyChange(restoredMerge, result.change, "backward")), [a, b, c]);
  }
}
for (const [records, opts, error] of [[[a, { ...b, path: "other.md" }], {}, /cross_document/], [[a, { ...b, markKind: "cloze" }], {}, /mark_kind/], [[a, b], { frozen: true }, /frozen/], [[a, { ...b, archived: true }], {}, /frozen/]]) {
  const before = JSON.stringify(records);
  assert.throws(() => core.mergeRecords(records, ["a", "b"], opts), error);
  assert.equal(JSON.stringify(records), before);
}
assert.equal(core.deleteRecords([a, b], ["missing"], { frozen: true }).change.ids.length, 0);
const edited = { ...c, commentMarkdown: "new unrelated edit" };
assert.deepEqual(core.applyChange(expected.records.map(item => item.id === "c" ? edited : item), expected.change, "backward").find(item => item.id === "c"), edited);
assert.throws(() => core.applyChange(expected.records.map(item => item.id === "a" ? { ...item, commentMarkdown: "new edit" } : item), expected.change, "backward"), /stale/);
assert.throws(() => core.applyChange([a, b, c], expected.change, "forward", { frozen: true }), /frozen/);
assert.equal(core.addRecord([a], record("adjacent", 5, 10)).records.length, 2);
const overlap = core.addRecord([record("a", 0, 12), record("b", 14, 20)], record("new", 8, 16), options);
assert.equal(overlap.records.length, 1);
assert.equal(overlap.annotation.commentMarkdown, "comment a\n\ncomment new\n\ncomment b");
assert.equal(overlap.annotation.rewriteMarkdown, "rewrite a\n\nrewrite new\n\nrewrite b");
assert.equal(core.addRecord([b], record("new", 8, 12), options).annotation.id, "new");
const markdown = "prefix\n" + text;
const anchored = core.anchorAnnotationsToMarkdown([expected.annotation], markdown, "target.md")[0];
assert.deepEqual(anchored.virtualRanges.map(range => markdown.slice(range.start, range.end)), ["Alpha", "Beta"]);
assert.deepEqual(anchored.mergedSources, [a, b]);
assert.equal(core.anchorAnnotationsToMarkdown([expected.annotation], "Alpha missing", "target.md")[0].orphaned, true);
const legacy = core.normalizeDocumentState({ schema_version: 1, draft_id: "legacy", annotations: [anchored] }, { path: "target.md" });
assert.deepEqual(core.normalizeDocumentState(JSON.parse(JSON.stringify(legacy))), legacy);
const movedByHost = { ...a, virtualRanges: [{ start: 7, end: 12 }], range: { start: 7, end: 12 }, sourceOffset: 7 };
const movedState = core.createDocumentState({ annotations: [movedByHost] }, { path: "fixture.md" });
assert.deepEqual(movedState.annotations[0].ranges, [{ start: 7, end: 12 }]);
assert.deepEqual(core.normalizeAnnotation({ ...movedByHost, virtualRanges: [], range: null, sourceOffset: null }).ranges, []);
const residualClear = { id: "clear", selectedText: "Alpha", ranges: [{ start: 0, end: 5 }], virtualRanges: [], range: { start: 0, end: 5 }, sourceOffset: 0 };
const clearedRecord = core.normalizeAnnotation(residualClear);
assert.deepEqual(core.recordRanges(residualClear), []);
assert.deepEqual(core.recordRanges(clearedRecord), []);
assert.equal(clearedRecord.range, null); assert.equal(clearedRecord.sourceOffset, null);
assert.deepEqual(core.recordRanges({ ranges: [{ start: 0, end: 5 }] }), [{ start: 0, end: 5 }]);
assert.deepEqual(core.recordRanges({ ...residualClear, virtualRanges: [{ start: 7, end: 12 }] }), [{ start: 7, end: 12 }]);
for (const legacyGeometry of [{ range: { start: 0, end: 5 } }, { ranges: [{ start: 0, end: 5 }] }]) {
  const historical = core.normalizeAnnotation({ id: "historical", selectedText: "Alpha", ...legacyGeometry });
  assert.deepEqual(core.recordRanges(historical), [{ start: 0, end: 5 }]);
  assert.deepEqual(core.normalizeDocumentState({ schema_version: 1, annotations: [historical] }).annotations[0].ranges, [{ start: 0, end: 5 }]);
}
const inline = core.normalizeAnnotation({ id: "inline", selectedText: "Alpha", originalText: "original", currentText: "Alpha",
  sourceFormat: "mark", renderMode: "inline_mark", sourceOffset: 0, range: { start: 0, end: 5 }, commentMarkdown: "comment", rewriteMarkdown: "rewrite" });
assert.equal(inline.renderMode, "inline_mark"); assert.equal(inline.sourceFormat, "mark");
assert.equal(inline.originalText, "original"); assert.equal(inline.commentMarkdown, "comment"); assert.equal(inline.rewriteMarkdown, "rewrite");
assert.deepEqual(core.recordRanges(inline), [{ start: 0, end: 5 }]);
const clearSidecar = core.createDocumentState({ annotations: [residualClear] });
assert.deepEqual(core.recordRanges(clearSidecar.annotations[0]), []);
assert.equal(clearSidecar.annotations[0].range, null); assert.equal(clearSidecar.annotations[0].sourceOffset, null);
let draft = core.createDraft({ sourceText: text, annotations: [a, b, c], articleMusing: { bodyMarkdown: "musing" }, qaCards: [{ id: "qa", questionMarkdown: "q", answerMarkdown: "a" }] });
draft = core.mergeAnnotations(draft, ["b", "a"]).draft;
draft = core.deleteAnnotation(draft, "a"); draft = core.undo(draft).draft; draft = core.undo(draft).draft;
assert.deepEqual(sorted(draft.annotations), [a, b, c]);
assert.equal(draft.qaCards[0].id, "qa"); assert.equal(draft.articleMusing.bodyMarkdown, "musing");
assert.throws(() => core.deleteAnnotation(core.markSaved(draft), "a"), /locked/);
// Repeated fragments, transformed prefixes, ambiguity and incomplete conversion.
const repeated = "NO:Alpha xx TARGET:Alpha gap END:Beta";
const sources = [["r1", "Alpha", "TARGET:"], ["r2", "Beta", "END:"]].map(([id, selectedText, contextBefore]) => {
  const start = repeated.indexOf(contextBefore) + contextBefore.length;
  return core.normalizeAnnotation({ id, selectedText, contextBefore, ranges: [{ start, end: start + selectedText.length }] });
});
const combined = core.mergeRecords(sources, ["r2", "r1"], { textForRange: range => repeated.slice(range.start, range.end) }).annotation;
for (const prefix of ["", "converted header\n"]) {
  const anchored = core.anchorAnnotationsToMarkdown([combined], prefix + repeated)[0];
  assert.equal(anchored.orphaned, false);
  assert.equal(anchored.ranges[0].start, prefix.length + repeated.indexOf("TARGET:") + "TARGET:".length);
}
const ambiguous = core.anchorAnnotationsToMarkdown([combined], "header Alpha xx Alpha gap Beta")[0];
assert.equal(ambiguous.orphaned, true); assert.deepEqual(ambiguous.ranges, []);
assert.equal(core.anchorAnnotationsToMarkdown([combined], "header Alpha only")[0].orphaned, true);
console.log("PASS dependency-free core: 12 permutations, lossless sources, inverse/stale, frozen/cross-document, repeated fragments and ambiguity, legacy, lifecycle");
