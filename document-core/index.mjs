import "./core.js";
const core = globalThis.LocalIrDraftCore;
export default core;
export const { mergeRecords, deleteRecords, addRecord, createChange, applyChange, recordRanges,
  normalizeDocumentState, createDocumentState, normalizeAnnotation, anchorAnnotationsToMarkdown } = core;
