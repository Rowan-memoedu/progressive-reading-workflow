export interface TextRange { start: number; end: number }
export interface Annotation { id: string; path?: string; markKind?: string; ranges?: TextRange[]; virtualRanges?: TextRange[]; range?: TextRange | null; [key: string]: any }
export interface Change { version: 1; kind: string; ids: string[]; before: Record<string, Annotation | null>; after: Record<string, Annotation | null> }
export interface Options { path?: string; frozen?: boolean; locked?: boolean; at?: string; mergeIds?: string[]; textForRange?: (range: TextRange) => string }
export interface Result { records: Annotation[]; annotation?: Annotation; change: Change }
export function mergeRecords(records: Annotation[], ids: string[], options?: Options): Result;
export function deleteRecords(records: Annotation[], ids: string[], options?: Options): Result;
export function addRecord(records: Annotation[], record: Annotation, options?: Options): Result;
export function createChange(before: Annotation[], after: Annotation[], kind?: string): Change;
export function applyChange(records: Annotation[], change: Change, direction?: "forward" | "backward", options?: Options): Annotation[];
export function recordRanges(record: Annotation): TextRange[];
export function normalizeAnnotation(record?: Partial<Annotation>): Annotation;
export function normalizeDocumentState(raw?: any, options?: any): any;
export function createDocumentState(raw?: any, options?: any): any;
export function anchorAnnotationsToMarkdown(records: Annotation[], markdown: string, path?: string): Annotation[];
/** Neutral intake contract; acquisition and standard processing belong to hosts. */
export type ReadingMaterial = { kind: "link"; url: string; metadata?: Record<string, unknown> } | { kind: "text"; text: string; sourceUrl?: string; metadata?: Record<string, unknown> };
declare const core: { mergeRecords: typeof mergeRecords; deleteRecords: typeof deleteRecords; addRecord: typeof addRecord; createChange: typeof createChange; applyChange: typeof applyChange; [key: string]: any };
export default core;
