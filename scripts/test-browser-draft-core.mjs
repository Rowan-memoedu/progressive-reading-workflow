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

let adjacentDraft = Core.createDraft({
  url: "https://local.test/adjacent",
  sourceText: "FirstSecond",
  pageText: "FirstSecond"
});
({ draft: adjacentDraft } = Core.addAnnotation(adjacentDraft, { selectedText: "First", ranges: [{ start: 0, end: 5 }] }));
({ draft: adjacentDraft } = Core.addAnnotation(adjacentDraft, { selectedText: "Second", ranges: [{ start: 5, end: 11 }] }));
assert.equal(adjacentDraft.annotations.length, 2, "adjacent half-open ranges must remain independently mergeable annotations");

let overlappingDraft = Core.createDraft({
  url: "https://local.test/overlapping",
  sourceText: "Alpha beta gamma",
  pageText: "Alpha beta gamma"
});
({ draft: overlappingDraft } = Core.addAnnotation(overlappingDraft, { selectedText: "Alpha beta", ranges: [{ start: 0, end: 10 }] }));
({ draft: overlappingDraft } = Core.addAnnotation(overlappingDraft, { selectedText: "beta gamma", ranges: [{ start: 6, end: 16 }] }));
assert.equal(overlappingDraft.annotations.length, 1, "genuinely overlapping ranges must continue to merge automatically");
assert.deepEqual(overlappingDraft.annotations[0].ranges, [{ start: 0, end: 16 }]);

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

const documentState = Core.createDocumentState(draft, {
  path: "04 Projects/渐进阅读工作流/阅读区/浏览器高亮/Draft test.md",
  title: "Draft test",
  sourceUrl: draft.url,
  destination: "reading",
  markdownSha256: "final-sha",
  rawMarkdownSha256: "raw-sha",
  conversionMethod: "readability"
});
assert.equal(documentState.schema, "local-ir.document-state");
assert.equal(documentState.document.status, "inbox");
assert.equal(documentState.annotations.length, 2);
assert.equal(documentState.annotations[0].renderMode, "virtual_decoration");
assert.equal(documentState.annotations[0].path, documentState.document.path);
assert.equal(documentState.qaCards[0].path, documentState.document.path);

const completedDocumentState = Core.createDocumentState(draft, {
  path: "04 Projects/渐进阅读工作流/待归档原文/Draft test.md",
  title: "Draft test",
  sourceUrl: draft.url,
  destination: "completed",
  documentStatus: "done",
  markdownSha256: "final",
  rawMarkdownSha256: "raw",
  conversionMethod: "readability_html",
  committedAt: "2026-08-16T00:00:00.000Z"
});
assert.equal(completedDocumentState.document.status, "done");
assert.equal(completedDocumentState.annotations.length, documentState.annotations.length);
assert.equal(completedDocumentState.articleMusing.bodyMarkdown, documentState.articleMusing.bodyMarkdown);
assert.equal(completedDocumentState.qaCards[0].questionMarkdown, documentState.qaCards[0].questionMarkdown);
assert.equal(documentState.articleMusing.path, documentState.document.path);

const localEdit = Core.replaceDocumentCollections(documentState, {
  path: documentState.document.path,
  annotations: documentState.annotations.map((annotation, index) => index === 0
    ? { ...annotation, type: "comment", commentMarkdown: "本地续写评论" }
    : annotation),
  qaCards: documentState.qaCards,
  articleMusing: { ...documentState.articleMusing, bodyMarkdown: "本地续写随想" }
});
assert.equal(localEdit.document.revision, documentState.document.revision + 1);
assert.equal(localEdit.annotations[0].commentMarkdown, "本地续写评论");
assert.equal(localEdit.articleMusing.bodyMarkdown, "本地续写随想");
assert.notEqual(Core.comparableDocumentState(documentState), Core.comparableDocumentState(localEdit));

const legacyState = Core.normalizeDocumentState({
  schema_version: 1,
  draft_id: "legacy-draft",
  revision: 4,
  source_type: "browser_page",
  source_metadata: { source_url: "https://local.test/legacy", source_title: "Legacy" },
  annotations: documentState.annotations,
  article_musing: documentState.articleMusing,
  qa_cards: documentState.qaCards,
  destination: "reading"
}, { path: "legacy.md" });
assert.equal(legacyState.document.id, "legacy-draft");
assert.equal(legacyState.document.revision, 4);
assert.equal(legacyState.document.path, "legacy.md");

const retryableCompletion = Core.markFailed(Core.markPending({
  ...draft,
  submitDestination: "completed"
}), "offline");
assert.equal(retryableCompletion.submitDestination, "completed");
assert.equal(retryableCompletion.status, "error");

console.log(JSON.stringify({
  status: "passed",
  checks: ["authoring_modes", "virtual_ranges", "overlapping_ranges_auto_merge", "adjacent_ranges_remain_separate", "merge", "undo", "musing", "qa_card", "save_lock", "complete_lock", "document_state", "completed_document_state", "local_roundtrip", "legacy_sidecar", "completion_retry_destination"]
}, null, 2));
