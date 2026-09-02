import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../browser-highlight-extension/draft-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowRoot = path.resolve(__dirname, "..");
const roots = [
  path.join(workflowRoot, "阅读区", "浏览器高亮"),
  path.join(workflowRoot, "待归档原文")
];
const Core = globalThis.LocalIrDraftCore;

async function collectSidecars(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md.browser-ir.json"))
    .map((entry) => path.join(entry.parentPath || entry.path, entry.name));
}

const sidecars = (await Promise.all(roots.map(collectSidecars))).flat().sort();
const report = {
  status: "passed",
  sidecars: sidecars.length,
  legacy: 0,
  annotations: 0,
  orphanedAfterMarkdownAnchor: 0,
  missingMarkdown: 0
};

for (const sidecarPath of sidecars) {
  const parsed = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
  const supported = parsed?.schema === Core.DOCUMENT_STATE_SCHEMA || parsed?.schema_version === 1;
  if (!supported) throw new Error(`unsupported_sidecar_schema:${sidecarPath}`);
  if (parsed?.schema_version === 1 && !parsed?.schema) report.legacy += 1;

  const markdownPath = sidecarPath.slice(0, -".browser-ir.json".length);
  const markdown = await fs.readFile(markdownPath, "utf8").catch(() => null);
  if (markdown === null) {
    report.missingMarkdown += 1;
    continue;
  }
  const vaultPath = path.relative(path.resolve(workflowRoot, "..", ".."), markdownPath).replaceAll(path.sep, "/");
  const state = Core.normalizeDocumentState(parsed, { path: vaultPath });
  const anchored = Core.anchorAnnotationsToMarkdown(state.annotations, markdown, vaultPath);
  report.annotations += anchored.length;
  report.orphanedAfterMarkdownAnchor += anchored.filter((annotation) => annotation.orphaned).length;
}

console.log(JSON.stringify(report, null, 2));
