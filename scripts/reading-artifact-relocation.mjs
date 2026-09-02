import fs from "node:fs/promises";
import path from "node:path";

function normalizedUrlIdentity(value) {
  const parsed = new URL(String(value || "").trim());
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.href;
}

function markdownSourceUrl(markdown) {
  const match = String(markdown || "").match(/^source_url:\s*(.+)$/mu);
  if (!match) return null;
  const raw = match[1].trim();
  if (raw === "null") return null;
  try {
    return raw.startsWith('"') ? JSON.parse(raw) : raw.replace(/^['"]|['"]$/gu, "");
  } catch {
    return raw.replace(/^['"]|['"]$/gu, "");
  }
}

async function markdownFiles(folder) {
  try {
    return (await fs.readdir(folder, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => path.join(folder, entry.name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function markdownFilesRecursive(folder) {
  const output = [];
  async function visit(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) output.push(target);
    }
  }
  await visit(folder);
  return output;
}

async function indexTargetMarkdown(folder, targetIdentities, { recursive = false } = {}) {
  const index = new Map();
  const files = recursive ? await markdownFilesRecursive(folder) : await markdownFiles(folder);
  for (const file of files) {
    const markdown = await fs.readFile(file, "utf8");
    const sourceUrl = markdownSourceUrl(markdown);
    if (!sourceUrl) continue;
    const identity = normalizedUrlIdentity(sourceUrl);
    if (!targetIdentities.has(identity)) continue;
    const existing = index.get(identity) || [];
    existing.push(file);
    index.set(identity, existing);
  }
  return index;
}

async function updateSidecar({ stateRoot, fileName, targetFile, workspaceRoot, destinationFolder }) {
  const sidecar = path.join(stateRoot, `${fileName}.browser-ir.json`);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(sidecar, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (parsed?.document) parsed.document.path = path.relative(workspaceRoot, targetFile).replaceAll("\\", "/");
  if (parsed?.browser?.sourceMetadata) parsed.browser.sourceMetadata.destination_folder = destinationFolder;
  const temporary = `${sidecar}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  try {
    await fs.rename(temporary, sidecar);
  } catch (error) {
    if (!new Set(["EEXIST", "EPERM"]).has(error?.code)) throw error;
    await fs.rm(sidecar, { force: true });
    await fs.rename(temporary, sidecar);
  }
  return true;
}

export async function relocateReadingArtifacts({
  readingRoot,
  stateRoot,
  workspaceRoot,
  sourceFolder = "浏览器高亮",
  destinationFolder,
  urls,
  requireComplete = false
}) {
  const targetIdentities = new Set((urls || []).map(normalizedUrlIdentity));
  const sourceRoot = path.resolve(readingRoot, ...String(sourceFolder).split("/"));
  const destinationRoot = path.resolve(readingRoot, ...String(destinationFolder).split("/"));
  await fs.mkdir(destinationRoot, { recursive: true });
  let moved = 0;
  let duplicateRemoved = 0;
  let sidecarsUpdated = 0;
  for (const sourceFile of await markdownFiles(sourceRoot)) {
    const sourceBuffer = await fs.readFile(sourceFile);
    const sourceUrl = markdownSourceUrl(sourceBuffer.toString("utf8"));
    if (!sourceUrl || !targetIdentities.has(normalizedUrlIdentity(sourceUrl))) continue;
    const targetFile = path.join(destinationRoot, path.basename(sourceFile));
    try {
      const targetBuffer = await fs.readFile(targetFile);
      if (!sourceBuffer.equals(targetBuffer)) throw new Error(`reading_artifact_destination_conflict_${path.basename(sourceFile)}`);
      await fs.rm(sourceFile);
      duplicateRemoved += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await fs.rename(sourceFile, targetFile);
      moved += 1;
    }
    if (await updateSidecar({ stateRoot, fileName: path.basename(sourceFile), targetFile, workspaceRoot, destinationFolder })) {
      sidecarsUpdated += 1;
    }
  }
  const destinationIndex = await indexTargetMarkdown(destinationRoot, targetIdentities);
  const sourceIndex = await indexTargetMarkdown(sourceRoot, targetIdentities);
  const duplicates = [...destinationIndex.entries()].filter(([, files]) => files.length > 1);
  if (duplicates.length) throw new Error(`reading_artifact_duplicate_destination_${duplicates.length}`);
  const missing = [...targetIdentities].filter((identity) => !destinationIndex.has(identity));
  const globalIndex = await indexTargetMarkdown(readingRoot, targetIdentities, { recursive: true });
  const globalDuplicates = [...globalIndex.entries()].filter(([, files]) => files.length > 1);
  const wrongFolder = [...globalIndex.values()].flat().filter((file) => path.dirname(file) !== destinationRoot);
  if (requireComplete && (missing.length || sourceIndex.size || globalDuplicates.length || wrongFolder.length)) {
    throw new Error(`reading_artifact_destination_unverified_missing_${missing.length}_source_${sourceIndex.size}_duplicates_${globalDuplicates.length}_wrong_${wrongFolder.length}`);
  }
  return {
    source_folder: sourceFolder,
    destination_folder: destinationFolder,
    expected: targetIdentities.size,
    moved,
    duplicate_removed: duplicateRemoved,
    sidecars_updated: sidecarsUpdated,
    destination_count: destinationIndex.size,
    source_count: sourceIndex.size,
    global_identity_count: globalIndex.size,
    global_duplicate_count: globalDuplicates.length,
    wrong_folder_count: wrongFolder.length,
    missing_count: missing.length,
    verified: missing.length === 0 && sourceIndex.size === 0 && globalDuplicates.length === 0 && wrongFolder.length === 0
  };
}
