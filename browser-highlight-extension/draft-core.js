(function installLocalIrDraftCore(root) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const AUTHORING_MODES = ["off", "processing", "cloze"];
  const ANNOTATION_TYPES = [
    "comment",
    "myth_truth",
    "sample_quote",
    "add_viewpoint",
    "question",
    "optimize",
    "example_viewpoint",
    "qa_card"
  ];

  function nowIso() {
    return new Date().toISOString();
  }

  function createId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeAuthoringMode(value, legacyEnabled = false) {
    if (AUTHORING_MODES.includes(value)) return value;
    return legacyEnabled ? "processing" : "off";
  }

  function toggleAuthoringMode(current, requested) {
    const normalizedCurrent = normalizeAuthoringMode(current);
    const normalizedRequested = normalizeAuthoringMode(requested);
    if (normalizedRequested === "off") return "off";
    return normalizedCurrent === normalizedRequested ? "off" : normalizedRequested;
  }

  function normalizeRanges(ranges) {
    const sorted = (Array.isArray(ranges) ? ranges : [])
      .map((range) => ({ start: Number(range?.start), end: Number(range?.end) }))
      .filter((range) => Number.isInteger(range.start) && Number.isInteger(range.end) && range.end > range.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const range of sorted) {
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        merged.push({ ...range });
      }
    }
    return merged;
  }

  function normalizeAnnotation(raw = {}) {
    const createdAt = String(raw.createdAt || nowIso());
    const selectedText = String(raw.selectedText || raw.originalText || "");
    const currentText = String(raw.currentText || selectedText);
    const type = ANNOTATION_TYPES.includes(raw.type) ? raw.type : "comment";
    return {
      id: String(raw.id || createId("annotation")),
      selectedText,
      originalText: String(raw.originalText || selectedText),
      currentText,
      type,
      commentMarkdown: String(raw.commentMarkdown || ""),
      rewriteMarkdown: String(raw.rewriteMarkdown || ""),
      hasRewrite: Boolean(raw.hasRewrite || String(raw.rewriteMarkdown || "").trim()),
      rewriteApplied: Boolean(raw.rewriteApplied),
      markKind: raw.markKind === "cloze" ? "cloze" : "highlight",
      ranges: normalizeRanges(raw.ranges),
      contextBefore: String(raw.contextBefore || ""),
      contextAfter: String(raw.contextAfter || ""),
      createdAt,
      updatedAt: String(raw.updatedAt || createdAt),
      archived: false
    };
  }

  function normalizeQaCard(raw = {}) {
    const createdAt = String(raw.createdAt || nowIso());
    return {
      id: String(raw.id || createId("qa")),
      source: raw.source === "annotation" ? "annotation" : "article",
      sourceAnnotationId: raw.sourceAnnotationId ? String(raw.sourceAnnotationId) : null,
      questionMarkdown: String(raw.questionMarkdown || "").trim(),
      answerMarkdown: String(raw.answerMarkdown || "").trim(),
      answerSourceText: String(raw.answerSourceText || ""),
      needsQuestionGeneration: Boolean(raw.needsQuestionGeneration),
      needsAnswerGeneration: Boolean(raw.needsAnswerGeneration || !String(raw.answerMarkdown || "").trim()),
      createdAt,
      updatedAt: String(raw.updatedAt || createdAt),
      archived: false
    };
  }

  function createDraft(source = {}) {
    const createdAt = String(source.createdAt || nowIso());
    return {
      schemaVersion: SCHEMA_VERSION,
      id: String(source.id || createId("browser-draft")),
      url: String(source.url || ""),
      title: String(source.title || ""),
      sourceType: String(source.sourceType || "browser_page"),
      sourceMetadata: { ...(source.sourceMetadata || {}) },
      userInstruction: String(source.userInstruction || ""),
      pageText: String(source.pageText || ""),
      sourceText: String(source.sourceText || source.pageText || ""),
      html: String(source.html || ""),
      annotations: (source.annotations || []).map(normalizeAnnotation),
      articleMusing: source.articleMusing ? { ...source.articleMusing } : null,
      qaCards: (source.qaCards || []).map(normalizeQaCard),
      undoStack: Array.isArray(source.undoStack) ? source.undoStack.slice(-30) : [],
      status: ["editing", "pending_submit", "submitting", "saved_locked", "completed_pending_archive", "error"].includes(source.status)
        ? source.status
        : "editing",
      dirty: source.dirty !== false,
      locked: Boolean(source.locked),
      revision: Number.isInteger(source.revision) ? source.revision : 0,
      createdAt,
      updatedAt: String(source.updatedAt || createdAt),
      submittedAt: source.submittedAt ? String(source.submittedAt) : null,
      lastError: source.lastError ? String(source.lastError) : null,
      receipt: source.receipt || null,
      submitDestination: ["reading", "completed"].includes(source.submitDestination)
        ? source.submitDestination
        : null,
      completionIntent: source.completionIntent ? { ...source.completionIntent } : null
    };
  }

  function normalizeDraft(raw = {}) {
    return createDraft(raw);
  }

  function editableDraft(draft) {
    if (draft.locked || draft.status === "saved_locked") throw new Error("draft_locked");
  }

  function snapshotAction(draft, kind) {
    return {
      kind,
      annotations: clone(draft.annotations),
      articleMusing: clone(draft.articleMusing),
      qaCards: clone(draft.qaCards),
      at: nowIso()
    };
  }

  function touch(draft) {
    draft.updatedAt = nowIso();
    draft.revision += 1;
    draft.dirty = true;
    draft.status = "editing";
    draft.lastError = null;
    return draft;
  }

  function pushUndo(draft, kind) {
    draft.undoStack.push(snapshotAction(draft, kind));
    draft.undoStack = draft.undoStack.slice(-30);
  }

  function rangesTouch(left, right) {
    return left.start <= right.end && right.start <= left.end;
  }

  function addAnnotation(rawDraft, rawAnnotation) {
    const draft = normalizeDraft(rawDraft);
    editableDraft(draft);
    pushUndo(draft, "add_annotation");
    const annotation = normalizeAnnotation(rawAnnotation);
    const overlapping = draft.annotations.filter((candidate) =>
      candidate.markKind === annotation.markKind &&
      candidate.ranges.some((left) => annotation.ranges.some((right) => rangesTouch(left, right)))
    );
    if (overlapping.length) {
      const ids = new Set(overlapping.map((item) => item.id));
      const primary = overlapping[0];
      annotation.id = primary.id;
      annotation.createdAt = primary.createdAt;
      annotation.commentMarkdown = primary.commentMarkdown;
      annotation.rewriteMarkdown = primary.rewriteMarkdown;
      annotation.type = primary.type;
      annotation.ranges = normalizeRanges([
        ...annotation.ranges,
        ...overlapping.flatMap((item) => item.ranges)
      ]);
      draft.annotations = draft.annotations.filter((item) => !ids.has(item.id));
    }
    draft.annotations.push(annotation);
    touch(draft);
    return { draft, annotation };
  }

  function updateAnnotation(rawDraft, id, patch = {}) {
    const draft = normalizeDraft(rawDraft);
    editableDraft(draft);
    const index = draft.annotations.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("annotation_not_found");
    pushUndo(draft, "update_annotation");
    draft.annotations[index] = normalizeAnnotation({
      ...draft.annotations[index],
      ...patch,
      id,
      updatedAt: nowIso()
    });
    touch(draft);
    return { draft, annotation: draft.annotations[index] };
  }

  function deleteAnnotation(rawDraft, id) {
    const draft = normalizeDraft(rawDraft);
    editableDraft(draft);
    if (!draft.annotations.some((item) => item.id === id)) return draft;
    pushUndo(draft, "delete_annotation");
    draft.annotations = draft.annotations.filter((item) => item.id !== id);
    touch(draft);
    return draft;
  }

  function mergeAnnotations(rawDraft, ids) {
    const draft = normalizeDraft(rawDraft);
    editableDraft(draft);
    const selected = draft.annotations.filter((item) => ids.includes(item.id));
    if (selected.length < 2) throw new Error("merge_requires_two_annotations");
    if (new Set(selected.map((item) => item.markKind)).size !== 1) throw new Error("merge_mark_kind_mismatch");
    pushUndo(draft, "merge_annotations");
    const primary = normalizeAnnotation({
      ...selected[0],
      ranges: normalizeRanges(selected.flatMap((item) => item.ranges)),
      selectedText: selected.map((item) => item.selectedText).join(" … "),
      currentText: selected.map((item) => item.currentText).join(" … "),
      updatedAt: nowIso()
    });
    const selectedIds = new Set(selected.map((item) => item.id));
    draft.annotations = draft.annotations.filter((item) => !selectedIds.has(item.id));
    draft.annotations.push(primary);
    touch(draft);
    return { draft, annotation: primary };
  }

  function undo(rawDraft) {
    const draft = normalizeDraft(rawDraft);
    editableDraft(draft);
    const action = draft.undoStack.pop();
    if (!action) return { draft, restored: false };
    draft.annotations = (action.annotations || []).map(normalizeAnnotation);
    draft.articleMusing = action.articleMusing || null;
    draft.qaCards = (action.qaCards || []).map(normalizeQaCard);
    touch(draft);
    return { draft, restored: true, kind: action.kind };
  }

  function saveMusing(rawDraft, bodyMarkdown) {
    const draft = normalizeDraft(rawDraft);
    editableDraft(draft);
    pushUndo(draft, "save_musing");
    const body = String(bodyMarkdown || "").trim();
    draft.articleMusing = body ? {
      id: draft.articleMusing?.id || createId("musing"),
      bodyMarkdown: body,
      aiStatus: draft.articleMusing?.aiStatus || "pending",
      createdAt: draft.articleMusing?.createdAt || nowIso(),
      updatedAt: nowIso(),
      archived: false
    } : null;
    touch(draft);
    return draft;
  }

  function addQaCard(rawDraft, rawCard) {
    const draft = normalizeDraft(rawDraft);
    editableDraft(draft);
    const card = normalizeQaCard(rawCard);
    if (!card.questionMarkdown) throw new Error("question_required");
    pushUndo(draft, "add_qa_card");
    draft.qaCards.push(card);
    touch(draft);
    return { draft, card };
  }

  function updateQaCard(rawDraft, id, patch) {
    const draft = normalizeDraft(rawDraft);
    editableDraft(draft);
    const index = draft.qaCards.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("qa_card_not_found");
    pushUndo(draft, "update_qa_card");
    const card = normalizeQaCard({ ...draft.qaCards[index], ...patch, id, updatedAt: nowIso() });
    if (!card.questionMarkdown) throw new Error("question_required");
    draft.qaCards[index] = card;
    touch(draft);
    return { draft, card };
  }

  function deleteQaCard(rawDraft, id) {
    const draft = normalizeDraft(rawDraft);
    editableDraft(draft);
    if (!draft.qaCards.some((item) => item.id === id)) return draft;
    pushUndo(draft, "delete_qa_card");
    draft.qaCards = draft.qaCards.filter((item) => item.id !== id);
    touch(draft);
    return draft;
  }

  function markPending(rawDraft) {
    const draft = normalizeDraft(rawDraft);
    if (draft.locked) return draft;
    draft.status = "pending_submit";
    draft.updatedAt = nowIso();
    return draft;
  }

  function markSaved(rawDraft, receipt) {
    const draft = normalizeDraft(rawDraft);
    draft.status = "saved_locked";
    draft.locked = true;
    draft.dirty = false;
    draft.submittedAt = nowIso();
    draft.updatedAt = draft.submittedAt;
    draft.lastError = null;
    draft.receipt = receipt || null;
    return draft;
  }

  function markCompleted(rawDraft, receipt) {
    const draft = markSaved(rawDraft, receipt);
    draft.status = "completed_pending_archive";
    return draft;
  }

  function markFailed(rawDraft, error) {
    const draft = normalizeDraft(rawDraft);
    draft.status = "error";
    draft.lastError = String(error || "submit_failed");
    draft.updatedAt = nowIso();
    return draft;
  }

  function summary(rawDraft) {
    const draft = normalizeDraft(rawDraft);
    return {
      id: draft.id,
      url: draft.url,
      status: draft.status,
      locked: draft.locked,
      dirty: draft.dirty,
      revision: draft.revision,
      annotations: draft.annotations.length,
      qaCards: draft.qaCards.length,
      hasMusing: Boolean(draft.articleMusing?.bodyMarkdown),
      lastError: draft.lastError
    };
  }

  root.LocalIrDraftCore = {
    SCHEMA_VERSION,
    AUTHORING_MODES,
    ANNOTATION_TYPES,
    normalizeAuthoringMode,
    toggleAuthoringMode,
    createDraft,
    normalizeDraft,
    normalizeAnnotation,
    normalizeQaCard,
    normalizeRanges,
    addAnnotation,
    updateAnnotation,
    deleteAnnotation,
    mergeAnnotations,
    undo,
    saveMusing,
    addQaCard,
    updateQaCard,
    deleteQaCard,
    markPending,
    markSaved,
    markCompleted,
    markFailed,
    summary,
    clone
  };
})(globalThis);
