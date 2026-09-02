(function installLocalIrDraftCore(root) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const DOCUMENT_STATE_SCHEMA = "local-ir.document-state";
  const DOCUMENT_STATE_VERSION = 1;
  const AUTHORING_MODES = ["off", "processing", "cloze"];
  const ANNOTATION_TYPES = [
    "highlight",
    "comment",
    "myth_truth",
    "rebuttal",
    "sample_quote",
    "later",
    "rewrite",
    "refine",
    "add_viewpoint",
    "rebuttal_rewrite",
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
    const type = ANNOTATION_TYPES.includes(raw.type) ? raw.type : "highlight";
    const ranges = normalizeRanges(Array.isArray(raw.ranges) ? raw.ranges : raw.virtualRanges);
    const range = raw.range && Number.isInteger(Number(raw.range.start)) && Number.isInteger(Number(raw.range.end))
      ? { start: Number(raw.range.start), end: Number(raw.range.end) }
      : ranges.length > 0
        ? { start: ranges[0].start, end: ranges[ranges.length - 1].end }
        : null;
    const contextBefore = String(raw.contextBefore || raw.anchor?.contextBefore || "");
    const contextAfter = String(raw.contextAfter || raw.anchor?.contextAfter || "");
    return {
      id: String(raw.id || createId("annotation")),
      path: String(raw.path || ""),
      selectedText,
      sourceFormat: raw.sourceFormat === "mark" || raw.sourceFormat === "legacy" ? raw.sourceFormat : "virtual",
      renderMode: raw.renderMode === "inline_mark" ? "inline_mark" : "virtual_decoration",
      protectedKind: raw.protectedKind ? String(raw.protectedKind) : null,
      originalText: String(raw.originalText || selectedText),
      currentText,
      type,
      commentMarkdown: String(raw.commentMarkdown || ""),
      rewriteMarkdown: String(raw.rewriteMarkdown || ""),
      hasRewrite: Boolean(raw.hasRewrite || String(raw.rewriteMarkdown || "").trim()),
      rewriteApplied: Boolean(raw.rewriteApplied),
      markKind: raw.markKind === "cloze" ? "cloze" : "highlight",
      orphaned: Boolean(raw.orphaned),
      lastKnownPath: String(raw.lastKnownPath || raw.path || ""),
      sourceOffset: raw.sourceOffset !== null && raw.sourceOffset !== undefined && Number.isInteger(Number(raw.sourceOffset))
        ? Number(raw.sourceOffset)
        : range?.start ?? null,
      range,
      virtualRanges: ranges,
      ranges,
      lineRange: raw.lineRange || null,
      anchor: raw.anchor || (contextBefore || contextAfter ? {
        sectionPath: [],
        paragraphIndex: null,
        sourceOffset: range?.start ?? null,
        contextBefore,
        contextAfter,
        contextHash: "",
        fragmentCount: 1,
        crossedBlankLines: false
      } : null),
      fragments: Array.isArray(raw.fragments) && raw.fragments.length > 0
        ? raw.fragments.map((fragment, index) => ({ index: Number(fragment?.index ?? index), text: String(fragment?.text || "") }))
        : [{ index: 0, text: currentText }],
      scope: ["heading_subtree", "list_subtree"].includes(raw.scope) ? raw.scope : "selection",
      headingPath: Array.isArray(raw.headingPath) ? raw.headingPath.map(String).filter(Boolean) : [],
      expandedText: String(raw.expandedText || currentText),
      expandedAnswerText: String(raw.expandedAnswerText || raw.expandedText || currentText),
      subtreeRange: raw.subtreeRange || null,
      contextBefore,
      contextAfter,
      createdAt,
      updatedAt: String(raw.updatedAt || createdAt),
      archived: Boolean(raw.archived)
    };
  }

  function normalizeQaCard(raw = {}) {
    const createdAt = String(raw.createdAt || nowIso());
    return {
      id: String(raw.id || createId("qa")),
      path: String(raw.path || ""),
      source: raw.source === "annotation" ? "annotation" : "article",
      sourceAnnotationId: raw.sourceAnnotationId ? String(raw.sourceAnnotationId) : null,
      questionMarkdown: String(raw.questionMarkdown || "").trim(),
      answerMarkdown: String(raw.answerMarkdown || "").trim(),
      answerSourceText: String(raw.answerSourceText || ""),
      needsQuestionGeneration: Boolean(raw.needsQuestionGeneration),
      needsAnswerGeneration: Boolean(raw.needsAnswerGeneration || !String(raw.answerMarkdown || "").trim()),
      createdAt,
      updatedAt: String(raw.updatedAt || createdAt),
      archived: Boolean(raw.archived)
    };
  }

  function normalizeArticleMusing(raw = {}, path = "") {
    const createdAt = String(raw.createdAt || nowIso());
    return {
      id: String(raw.id || createId("musing")),
      path: String(raw.path || path || ""),
      bodyMarkdown: String(raw.bodyMarkdown || ""),
      aiStatus: ["resolved", "skipped"].includes(raw.aiStatus) ? raw.aiStatus : "pending",
      createdAt,
      updatedAt: String(raw.updatedAt || createdAt),
      archived: Boolean(raw.archived)
    };
  }

  function findTextRange(markdown, selectedText, contextBefore = "", contextAfter = "") {
    const source = String(markdown || "");
    const needle = String(selectedText || "").trim();
    if (!source || !needle) return null;
    const candidates = [];
    let cursor = 0;
    while (cursor <= source.length) {
      const start = source.indexOf(needle, cursor);
      if (start < 0) break;
      const end = start + needle.length;
      const before = String(contextBefore || "").trim().slice(-80);
      const after = String(contextAfter || "").trim().slice(0, 80);
      let score = 0;
      if (before && source.slice(Math.max(0, start - before.length), start) === before) score += 2;
      if (after && source.slice(end, end + after.length) === after) score += 2;
      candidates.push({ start, end, score });
      cursor = start + Math.max(1, needle.length);
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => right.score - left.score || left.start - right.start);
    return { start: candidates[0].start, end: candidates[0].end };
  }

  function anchorAnnotationsToMarkdown(rawAnnotations, markdown, path = "") {
    return (Array.isArray(rawAnnotations) ? rawAnnotations : []).map((raw) => {
      const annotation = normalizeAnnotation({ ...raw, path, lastKnownPath: path });
      const located = findTextRange(markdown, annotation.originalText || annotation.selectedText, annotation.contextBefore, annotation.contextAfter)
        || findTextRange(markdown, annotation.selectedText, annotation.contextBefore, annotation.contextAfter);
      if (!located) {
        return normalizeAnnotation({
          ...annotation,
          path,
          lastKnownPath: path,
          range: null,
          ranges: [],
          virtualRanges: [],
          sourceOffset: null,
          orphaned: true
        });
      }
      return normalizeAnnotation({
        ...annotation,
        path,
        lastKnownPath: path,
        range: located,
        ranges: [located],
        virtualRanges: [located],
        sourceOffset: located.start,
        orphaned: false,
        anchor: {
          ...(annotation.anchor || {}),
          sectionPath: annotation.anchor?.sectionPath || [],
          paragraphIndex: annotation.anchor?.paragraphIndex ?? null,
          sourceOffset: located.start,
          contextBefore: annotation.contextBefore,
          contextAfter: annotation.contextAfter,
          contextHash: annotation.anchor?.contextHash || "",
          fragmentCount: annotation.fragments.length,
          crossedBlankLines: Boolean(annotation.anchor?.crossedBlankLines)
        }
      });
    });
  }

  function normalizeDocumentState(raw = {}, options = {}) {
    const legacy = raw && raw.schema_version === 1 && !raw.schema;
    const rawDocument = legacy ? {} : (raw.document || {});
    const rawBrowser = legacy ? {
      destination: raw.destination,
      userInstruction: raw.user_instruction,
      sourceMetadata: raw.source_metadata || {},
      completionIntent: raw.completion_intent || null
    } : (raw.browser || {});
    const sourceMetadata = rawBrowser.sourceMetadata || {};
    const documentPath = String(options.path || rawDocument.path || "");
    const createdAt = String(rawDocument.createdAt || raw.created_at || nowIso());
    const updatedAt = String(rawDocument.updatedAt || raw.updated_at || createdAt);
    const revision = Math.max(0, Math.round(Number(rawDocument.revision ?? raw.revision) || 0));
    const annotations = (Array.isArray(raw.annotations) ? raw.annotations : []).map((annotation) => normalizeAnnotation({
      ...annotation,
      path: documentPath,
      lastKnownPath: documentPath
    }));
    const qaCards = (Array.isArray(raw.qaCards) ? raw.qaCards : Array.isArray(raw.qa_cards) ? raw.qa_cards : []).map((card) => normalizeQaCard({
      ...card,
      path: documentPath
    }));
    const rawMusing = raw.articleMusing ?? raw.article_musing ?? null;
    return {
      schema: DOCUMENT_STATE_SCHEMA,
      schemaVersion: DOCUMENT_STATE_VERSION,
      document: {
        id: String(rawDocument.id || raw.draft_id || createId("document")),
        path: documentPath,
        title: String(rawDocument.title || sourceMetadata.source_title || ""),
        sourceUrl: String(rawDocument.sourceUrl || sourceMetadata.source_url || ""),
        sourceType: String(rawDocument.sourceType || raw.source_type || "browser_page"),
        status: ["inbox", "reading", "later", "suspended", "done", "export_package_ready", "archived"].includes(rawDocument.status)
          ? rawDocument.status
          : rawBrowser.destination === "completed" || raw.status === "completed_pending_archive" ? "done" : "inbox",
        deferUntil: rawDocument.deferUntil ? String(rawDocument.deferUntil) : null,
        revision,
        createdAt,
        updatedAt,
        handoff: {
          direction: "browser_to_obsidian",
          state: "ready",
          owner: rawDocument.handoff?.owner === "browser" ? "browser" : "obsidian",
          committedAt: String(rawDocument.handoff?.committedAt || updatedAt)
        }
      },
      content: {
        markdownSha256: String(raw.content?.markdownSha256 || ""),
        rawMarkdownSha256: String(raw.content?.rawMarkdownSha256 || sourceMetadata.raw_markdown_sha256 || ""),
        conversionMethod: String(raw.content?.conversionMethod || sourceMetadata.conversion_method || "")
      },
      annotations,
      articleMusing: rawMusing ? normalizeArticleMusing(rawMusing, documentPath) : null,
      qaCards,
      browser: {
        destination: rawBrowser.destination === "completed" ? "completed" : "reading",
        userInstruction: String(rawBrowser.userInstruction || ""),
        sourceMetadata: { ...sourceMetadata },
        completionIntent: rawBrowser.completionIntent || null
      }
    };
  }

  function createDocumentState(rawDraft = {}, options = {}) {
    const draft = normalizeDraft(rawDraft);
    const path = String(options.path || "");
    const committedAt = String(options.committedAt || nowIso());
    const documentStatus = ["inbox", "reading", "later", "suspended", "done", "archived"].includes(options.documentStatus)
      ? options.documentStatus
      : options.destination === "completed" ? "done" : "inbox";
    return normalizeDocumentState({
      schema: DOCUMENT_STATE_SCHEMA,
      schemaVersion: DOCUMENT_STATE_VERSION,
      document: {
        id: draft.id,
        path,
        title: String(options.title || draft.title || ""),
        sourceUrl: String(options.sourceUrl || draft.url || ""),
        sourceType: draft.sourceType,
        status: documentStatus,
        deferUntil: options.deferUntil ? String(options.deferUntil) : null,
        revision: draft.revision,
        createdAt: draft.createdAt,
        updatedAt: committedAt,
        handoff: {
          direction: "browser_to_obsidian",
          state: "ready",
          owner: "obsidian",
          committedAt
        }
      },
      content: {
        markdownSha256: String(options.markdownSha256 || ""),
        rawMarkdownSha256: String(options.rawMarkdownSha256 || ""),
        conversionMethod: String(options.conversionMethod || "")
      },
      annotations: draft.annotations,
      articleMusing: draft.articleMusing,
      qaCards: draft.qaCards,
      browser: {
        destination: options.destination === "completed" ? "completed" : "reading",
        userInstruction: draft.userInstruction,
        sourceMetadata: {
          ...draft.sourceMetadata,
          source_url: String(options.sourceUrl || draft.url || ""),
          source_title: String(options.title || draft.title || "")
        },
        completionIntent: options.destination === "completed" ? "pending_archive" : null
      }
    }, { path });
  }

  function replaceDocumentCollections(rawState, collections = {}) {
    const current = normalizeDocumentState(rawState, { path: collections.path || rawState?.document?.path || "" });
    const now = String(collections.updatedAt || nowIso());
    return normalizeDocumentState({
      ...current,
      document: {
        ...current.document,
        title: String(collections.title ?? current.document.title),
        status: collections.status ?? current.document.status,
        deferUntil: collections.deferUntil === undefined ? current.document.deferUntil : collections.deferUntil,
        revision: current.document.revision + 1,
        updatedAt: now,
        handoff: {
          ...current.document.handoff,
          owner: "obsidian",
          committedAt: now
        }
      },
      annotations: collections.annotations ?? current.annotations,
      qaCards: collections.qaCards ?? current.qaCards,
      articleMusing: collections.articleMusing === undefined ? current.articleMusing : collections.articleMusing
    }, { path: collections.path || current.document.path });
  }

  function comparableDocumentState(rawState) {
    const state = normalizeDocumentState(rawState, { path: rawState?.document?.path || "" });
    return JSON.stringify({
      document: {
        path: state.document.path,
        title: state.document.title,
        status: state.document.status,
        deferUntil: state.document.deferUntil
      },
      annotations: state.annotations,
      articleMusing: state.articleMusing,
      qaCards: state.qaCards
    });
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
      submitMode: source.submitMode === "standard_preprocess" ? "standard_preprocess" : "local",
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
    return left.start < right.end && right.start < left.end;
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
      lastError: draft.lastError,
      submitMode: draft.submitMode
    };
  }

  root.LocalIrDraftCore = {
    SCHEMA_VERSION,
    DOCUMENT_STATE_SCHEMA,
    DOCUMENT_STATE_VERSION,
    AUTHORING_MODES,
    ANNOTATION_TYPES,
    normalizeAuthoringMode,
    toggleAuthoringMode,
    createDraft,
    normalizeDraft,
    normalizeAnnotation,
    normalizeQaCard,
    normalizeArticleMusing,
    findTextRange,
    anchorAnnotationsToMarkdown,
    normalizeDocumentState,
    createDocumentState,
    replaceDocumentCollections,
    comparableDocumentState,
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
