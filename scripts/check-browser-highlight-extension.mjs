import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowRoot = path.resolve(__dirname, "..");
const extensionRoot = path.join(workflowRoot, "browser-highlight-extension");
const manifestPath = path.join(extensionRoot, "manifest.json");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
if (manifest.manifest_version !== 3) throw new Error("manifest_version_must_be_3");
if (manifest.version !== "0.4.0") throw new Error(`unexpected_manifest_version:${manifest.version}`);
if (!manifest.permissions?.includes("scripting")) throw new Error("missing_scripting_permission");
if (!manifest.permissions?.includes("activeTab")) throw new Error("missing_activeTab_permission");
if (!manifest.permissions?.includes("storage")) throw new Error("missing_storage_permission");
if (!manifest.permissions?.includes("tabs")) throw new Error("missing_tabs_permission");
if (!manifest.permissions?.includes("unlimitedStorage")) throw new Error("missing_unlimitedStorage_permission");
for (const pattern of manifest.host_permissions || []) {
  if (pattern.includes(":*")) throw new Error(`invalid_port_wildcard_match_pattern:${pattern}`);
}
for (const pattern of ["http://127.0.0.1/*", "http://localhost/*"]) {
  if (!manifest.host_permissions?.includes(pattern)) throw new Error(`missing_host_permission:${pattern}`);
}

const requiredFiles = [
  "draft-core.js",
  "background.js",
  "content.js",
  "content.css",
  "popup.html",
  "popup.js",
  "lib/web-highlighter.min.js"
];

for (const relative of requiredFiles) {
  await fs.access(path.join(extensionRoot, relative));
}

const popupJs = await fs.readFile(path.join(extensionRoot, "popup.js"), "utf8");
if (!popupJs.includes("chrome.scripting.executeScript")) throw new Error("popup_missing_executeScript_injection");
if (!popupJs.includes("chrome.scripting.insertCSS")) throw new Error("popup_missing_insertCSS_injection");
if (!popupJs.includes("get-content-status")) throw new Error("popup_missing_content_status_probe");
if (!popupJs.includes("37829-37849")) throw new Error("popup_missing_port_scan_label");
if (!popupJs.includes('VERSION = "0.4.0"')) throw new Error("popup_missing_version");
if (!popupJs.includes("function chromeCallback")) throw new Error("popup_missing_callback_wrapper");
if (!popupJs.includes("diagnose-ping")) throw new Error("popup_missing_diagnose_ping");
if (!popupJs.includes("/browser-highlight-test")) throw new Error("popup_missing_test_page_route");
if (/chrome\.tabs\.query\([^,\n]+\)\.then|chrome\.storage\.local\.get\([^,\n]+\)\.then|chrome\.tabs\.sendMessage\([^,\n]+\)\.catch/.test(popupJs)) {
  throw new Error("popup_uses_promise_style_chrome_api");
}

const popupHtml = await fs.readFile(path.join(extensionRoot, "popup.html"), "utf8");
if (!popupHtml.includes("v0.4.0")) throw new Error("popup_html_missing_version");
if (popupHtml.includes('id="enabled"')) throw new Error("popup_must_not_own_authoring_mode");
for (const id of ["diagnose", "openTest", "health", "saveDraft", "completeReading"]) {
  if (!popupHtml.includes(`id="${id}"`)) throw new Error(`popup_html_missing_button:${id}`);
}

const backgroundJs = await fs.readFile(path.join(extensionRoot, "background.js"), "utf8");
if (!backgroundJs.includes("PORT_SCAN_START = 37829")) throw new Error("background_missing_port_scan_start");
if (!backgroundJs.includes("PORT_SCAN_END = 37849")) throw new Error("background_missing_port_scan_end");
if (!backgroundJs.includes("findServicePort")) throw new Error("background_missing_port_probe");
if (!backgroundJs.includes('VERSION = "0.4.0"')) throw new Error("background_missing_version");
if (!backgroundJs.includes("function chromeCallback")) throw new Error("background_missing_callback_wrapper");
if (!backgroundJs.includes("diagnose-ping")) throw new Error("background_missing_diagnose_ping");
if (/chrome\.storage\.local\.get\([^,\n]+\)\.then|chrome\.storage\.local\.set\([^,\n]+\)\.then/.test(backgroundJs)) {
  throw new Error("background_uses_promise_style_chrome_storage");
}

const contentJs = await fs.readFile(path.join(extensionRoot, "content.js"), "utf8");
if (!contentJs.includes("__localIrBrowserHighlightContentLoaded")) throw new Error("content_missing_idempotent_guard");
if (!contentJs.includes("LocalIrDraftCore")) throw new Error("content_missing_draft_core");
if (!contentJs.includes("完成阅读")) throw new Error("content_missing_complete_reading");
if (!contentJs.includes("初始化加工")) throw new Error("content_missing_manual_initialization");
if (!contentJs.includes("加工模式") || !contentJs.includes("挖空模式")) throw new Error("content_missing_dual_authoring_modes");
if (!contentJs.includes('MODE_KEY = "localIrAuthoringMode"')) throw new Error("content_missing_global_mode_key");
if (!contentJs.includes('if (!draft || draft.locked || authoringMode === "off") return;')) {
  throw new Error("content_selection_must_require_initialized_active_mode");
}

const appJs = await fs.readFile(path.join(workflowRoot, "scripts", "progressive-reading-app.mjs"), "utf8");
if (!appJs.includes("/browser-highlight-test")) throw new Error("app_missing_browser_highlight_test_route");
if (!appJs.includes("browser_page_highlight")) throw new Error("app_missing_full_page_highlight_mode");
if (!appJs.includes("Readability")) throw new Error("app_missing_readability_conversion");
if (!appJs.includes("/api/highlights/commit")) throw new Error("app_missing_browser_commit_route");
if (!appJs.includes("/api/highlights/complete")) throw new Error("app_missing_browser_complete_route");
if (!appJs.includes("PROGRESSIVE_READING_WORKFLOW_ROOT")) throw new Error("app_missing_explicit_local_root_override");
if (!appJs.includes("--git-common-dir")) throw new Error("app_missing_main_checkout_root_resolution");

console.log(JSON.stringify({
  checked: extensionRoot,
  files: requiredFiles.length,
  manifest: "ok",
  injection: "ok",
  portProbe: "ok",
  diagnostics: "ok",
  testPage: "ok"
}, null, 2));
