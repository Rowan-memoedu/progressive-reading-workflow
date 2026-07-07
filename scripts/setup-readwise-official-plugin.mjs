import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowRoot = path.resolve(__dirname, "..");
const vaultRoot = path.resolve(workflowRoot, "..", "..");
const pluginId = "readwise-official";
const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", pluginId);
const communityPluginsPath = path.join(vaultRoot, ".obsidian", "community-plugins.json");
const dataPath = path.join(pluginDir, "data.json");
const readwiseDir = normalizeObsidianPath(path.relative(vaultRoot, path.join(workflowRoot, "imports", "readwise-obsidian-raw")));

const releaseFiles = [
  "main.js",
  "manifest.json",
  "styles.css"
];

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  await fs.mkdir(pluginDir, { recursive: true });
  await Promise.all(releaseFiles.map(downloadReleaseFile));
  const manifest = JSON.parse(await fs.readFile(path.join(pluginDir, "manifest.json"), "utf8"));
  if (manifest.id !== pluginId) {
    throw new Error(`Downloaded unexpected plugin id: ${manifest.id}`);
  }

  const enabledPlugins = await readJsonArray(communityPluginsPath);
  if (!enabledPlugins.includes(pluginId)) {
    enabledPlugins.push(pluginId);
    await writeJson(communityPluginsPath, enabledPlugins);
  }

  await writeSettings();
  await fs.mkdir(path.join(workflowRoot, "imports", "readwise-obsidian-raw"), { recursive: true });
  await fs.mkdir(path.join(workflowRoot, "imports", "readwise-migration"), { recursive: true });
  await fs.mkdir(path.join(workflowRoot, "阅读区", "Readwise 迁入"), { recursive: true });

  console.log(`Readwise Official installed/enabled: ${manifest.version}`);
  console.log(`Readwise base folder set to: ${readwiseDir}`);
  console.log("Open Obsidian, connect Readwise, enable Export All Reader Documents on Readwise, then run the first sync.");
}

async function downloadReleaseFile(fileName) {
  const url = `https://github.com/readwiseio/obsidian-readwise/releases/latest/download/${fileName}`;
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60000),
    headers: {
      "User-Agent": "Codex Readwise setup"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${fileName}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(path.join(pluginDir, fileName), buffer);
}

async function readJsonArray(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeSettings() {
  const existing = await readJsonObject(dataPath);
  const settings = {
    token: existing.token || "",
    readwiseDir,
    frequency: existing.frequency || "0",
    triggerOnLoad: false,
    isSyncing: false,
    lastSyncFailed: Boolean(existing.lastSyncFailed),
    lastSavedStatusID: Number(existing.lastSavedStatusID || 0),
    currentSyncStatusID: 0,
    refreshBooks: Boolean(existing.refreshBooks),
    booksToRefresh: Array.isArray(existing.booksToRefresh) ? existing.booksToRefresh : [],
    failedBooks: Array.isArray(existing.failedBooks) ? existing.failedBooks : [],
    booksIDsMap: existing.booksIDsMap && typeof existing.booksIDsMap === "object" ? existing.booksIDsMap : {},
    reimportShowConfirmation: existing.reimportShowConfirmation !== false
  };
  await writeJson(dataPath, settings);
}

async function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeObsidianPath(value) {
  return value.split(path.sep).join("/");
}
