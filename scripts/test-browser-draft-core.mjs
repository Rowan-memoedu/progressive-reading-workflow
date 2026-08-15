import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(__dirname, "..", "browser-highlight-extension", "draft-core.js")).href);
const Core = globalThis.LocalIrDraftCore;

assert.ok(Core, "draft core must install globally");
assert.equal(Core.normalizeAuthoringMode(null), "off");
assert.equal(Core.normalizeAuthoringMode(null, true), "processing");
assert.equal(Core.toggleAuthoringMode("off", "processing"), "processing");
assert.equal(Core.toggleAuthoringMode("processing", "cloze"), "cloze");
assert.equal(Core.toggleAuthoringMode("cloze", "cloze"), "off");

let draft = Core.createDraft({
  url: "https://local.test/article",
  title: "Draft test",
  sourceText: "Alpha beta gamma delta epsilon",
  pageText: "Alpha beta gamma delta epsilon",
  html: "<article><p>Alpha beta gamma delta epsilon</p></article>"
});

({ draft } = Core.addAnnotation(draft, {
  selectedText: "beta",
  ranges: [{ start: 6, end: 10 }]
}));
assert.equal(draft.annotations.length, 1);
assert.equal(draft.status, "editing");

({ draft } = Core.addAnnotation(draft, {
  selectedText: "gamma",
  ranges: [{ start: 11, end: 16 }]
}));
assert.equal(draft.annotations.length, 2);

const ids = draft.annotations.map((item) => item.id);
({ draft } = Core.mergeAnnotations(draft, ids));
assert.equal(draft.annotations.length, 1);
assert.deepEqual(draft.annotations[0].ranges, [{ start: 6, end: 10 }, { start: 11, end: 16 }]);

const undone = Core.undo(draft);
draft = undone.draft;
assert.equal(undone.restored, true);
assert.equal(draft.annotations.length, 2);

draft = Core.saveMusing(draft, "一条文章随想");
assert.equal(draft.articleMusing.bodyMarkdown, "一条文章随想");

({ draft } = Core.addQaCard(draft, { questionMarkdown: "为什么？", answerMarkdown: "因为。" }));
assert.equal(draft.qaCards.length, 1);
assert.equal(draft.qaCards[0].needsAnswerGeneration, false);

const saved = Core.markSaved(draft, { status: "ok" });
assert.equal(saved.status, "saved_locked");
assert.equal(saved.locked, true);
assert.throws(() => Core.addAnnotation(saved, { selectedText: "x", ranges: [{ start: 0, end: 1 }] }), /draft_locked/);

const completed = Core.markCompleted(draft, { status: "done" });
assert.equal(completed.status, "completed_pending_archive");
assert.equal(completed.locked, true);

const retryableCompletion = Core.markFailed(Core.markPending({
  ...draft,
  submitDestination: "completed"
}), "offline");
assert.equal(retryableCompletion.submitDestination, "completed");
assert.equal(retryableCompletion.status, "error");

console.log(JSON.stringify({
  status: "passed",
  checks: ["authoring_modes", "virtual_ranges", "merge", "undo", "musing", "qa_card", "save_lock", "complete_lock", "completion_retry_destination"]
}, null, 2));
