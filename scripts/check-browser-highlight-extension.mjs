import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowRoot = path.resolve(__dirname, "..");
const extensionRoot = path.join(workflowRoot, "browser-highlight-extension");
const manifestPath = path.join(extensionRoot, "manifest.json");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
if (manifest.manifest_version !== 3) throw new Error("manifest_version_must_be_3");
if (manifest.version !== "0.5.17") throw new Error(`unexpected_manifest_version:${manifest.version}`);
if (!manifest.permissions?.includes("scripting")) throw new Error("missing_scripting_permission");
if (!manifest.permissions?.includes("activeTab")) throw new Error("missing_activeTab_permission");
if (!manifest.permissions?.includes("storage")) throw new Error("missing_storage_permission");
if (!manifest.permissions?.includes("tabs")) throw new Error("missing_tabs_permission");
if (!manifest.permissions?.includes("unlimitedStorage")) throw new Error("missing_unlimitedStorage_permission");
if (manifest.permissions?.includes("cookies")) throw new Error("extension_must_not_request_cookies_permission");
for (const pattern of manifest.host_permissions || []) {
  if (pattern.includes(":*")) throw new Error(`invalid_port_wildcard_match_pattern:${pattern}`);
}
const exactHostPermissions = [
  "http://127.0.0.1/*",
  "http://localhost/*"
];
if (JSON.stringify([...(manifest.host_permissions || [])].sort()) !== JSON.stringify([...exactHostPermissions].sort())) {
  throw new Error("host_permissions_must_be_loopback_only");
}
if ((manifest.optional_host_permissions || []).length > 0) throw new Error("extension_must_not_request_optional_host_permissions");

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
if (!popupJs.includes(`VERSION = "${manifest.version}"`)) throw new Error("popup_missing_version");
if (!popupJs.includes("function chromeCallback")) throw new Error("popup_missing_callback_wrapper");
if (!popupJs.includes("diagnose-ping")) throw new Error("popup_missing_diagnose_ping");
if (!popupJs.includes("/browser-highlight-test")) throw new Error("popup_missing_test_page_route");
if (/chrome\.tabs\.query\([^,\n]+\)\.then|chrome\.storage\.local\.get\([^,\n]+\)\.then|chrome\.tabs\.sendMessage\([^,\n]+\)\.catch/.test(popupJs)) {
  throw new Error("popup_uses_promise_style_chrome_api");
}

const popupHtml = await fs.readFile(path.join(extensionRoot, "popup.html"), "utf8");
if (!popupHtml.includes(`v${manifest.version}`)) throw new Error("popup_html_missing_version");
if (popupHtml.includes('id="enabled"')) throw new Error("popup_must_not_own_authoring_mode");
for (const id of ["diagnose", "openTest", "health", "saveDraft", "completeReading"]) {
  if (!popupHtml.includes(`id="${id}"`)) throw new Error(`popup_html_missing_button:${id}`);
}
if (/syncLoginState|sync-social-login-state|同步知乎与 X 登录状态|cookieSync/iu.test(`${popupHtml}\n${popupJs}`)) {
  throw new Error("popup_must_not_expose_cookie_sync_ui_or_message");
}

const backgroundJs = await fs.readFile(path.join(extensionRoot, "background.js"), "utf8");
if (!backgroundJs.includes("PORT_SCAN_START = 37829")) throw new Error("background_missing_port_scan_start");
if (!backgroundJs.includes("PORT_SCAN_END = 37849")) throw new Error("background_missing_port_scan_end");
if (!backgroundJs.includes("findServicePort")) throw new Error("background_missing_port_probe");
if (!backgroundJs.includes(`VERSION = "${manifest.version}"`)) throw new Error("background_missing_version");
if (!backgroundJs.includes('"/api/highlights/import-local"')) throw new Error("background_missing_standard_import_endpoint");
if (!backgroundJs.includes('"/api/highlights/import-local-urls"')) throw new Error("background_missing_standard_url_import_endpoint");
if (!backgroundJs.includes('message?.type === "draft-import-local"')) throw new Error("background_missing_standard_import_message");
if (!backgroundJs.includes('result?.status === "imported_with_warnings"')) throw new Error("background_missing_readable_warning_success");
if (!backgroundJs.includes('type: "context-import-current-page"')) throw new Error("background_current_page_context_does_not_reuse_content_import");
if (backgroundJs.includes("chrome.tabs.create")) throw new Error("background_url_import_must_not_create_tabs");
if (!backgroundJs.includes("createBrowserImportRequest") || !backgroundJs.includes("waitForBrowserImportRequest")) throw new Error("background_context_link_must_use_shared_broker");
if (backgroundJs.includes("claimBrowserImportTask") || backgroundJs.includes("completeBrowserImportTask") || backgroundJs.includes("runBrowserImportWorker")) throw new Error("extension_must_not_claim_server_import_tasks");
if (backgroundJs.includes('credentials: "include"') || backgroundJs.includes("chrome.permissions")) throw new Error("extension_must_not_use_ambient_fetch_credentials_or_dynamic_permissions");
if (!backgroundJs.includes('new Set(["requires_browser_auth", "requires_js_render"])')) throw new Error("background_missing_shared_broker_degraded_status_display");
if (/chrome\.cookies|COOKIE_SYNC_|cookies\/sync|url-cookie-sync|sync-social-login-state|syncSocialLoginState/iu.test(backgroundJs)) {
  throw new Error("background_must_not_contain_cookie_sync_capability");
}
if (!backgroundJs.includes("requestJsonReliable") || !backgroundJs.includes("TRANSPORT_MAX_ATTEMPTS = 3")) throw new Error("background_missing_transport_retry");
if (!backgroundJs.includes("client_request_id")) throw new Error("background_missing_idempotent_request_key");
if (backgroundJs.includes('requestJson("/api/import"')) throw new Error("background_context_menu_uses_legacy_import_endpoint");
if (!backgroundJs.includes('current?.submitDestination === "completed"')) throw new Error("background_reimport_does_not_preserve_completed_destination");
if (!backgroundJs.includes("function chromeCallback")) throw new Error("background_missing_callback_wrapper");
if (!backgroundJs.includes("diagnose-ping")) throw new Error("background_missing_diagnose_ping");
if (!backgroundJs.includes("draft-resubmit") || !backgroundJs.includes("options.force")) throw new Error("background_missing_locked_draft_resubmit");
if (!backgroundJs.includes('message?.type === "draft-discard"') || !backgroundJs.includes("discardDraft")) throw new Error("background_missing_draft_discard");
if (/chrome\.storage\.local\.get\([^,\n]+\)\.then|chrome\.storage\.local\.set\([^,\n]+\)\.then/.test(backgroundJs)) {
  throw new Error("background_uses_promise_style_chrome_storage");
}

const contentJs = await fs.readFile(path.join(extensionRoot, "content.js"), "utf8");
if (!contentJs.includes("生成的 Markdown 有瑕疵，请复核")) throw new Error("content_missing_readable_warning_notice");
if (!contentJs.includes("__localIrBrowserHighlightContentLoaded")) throw new Error("content_missing_idempotent_guard");
if (!contentJs.includes("LocalIrDraftCore")) throw new Error("content_missing_draft_core");
if (!contentJs.includes("完成阅读")) throw new Error("content_missing_complete_reading");
if (!contentJs.includes("放弃阅读") || !contentJs.includes("discardCurrentDraft")) throw new Error("content_missing_discard_reading");
if (!contentJs.includes("button.abandon{background:#d92d20")) throw new Error("content_discard_button_must_be_red");
if (!contentJs.includes("初始化加工")) throw new Error("content_missing_manual_initialization");
if (!contentJs.includes("导入本地")) throw new Error("content_missing_standard_import_button");
if (!contentJs.includes("local_ir_authoring_initialized")) throw new Error("content_missing_explicit_authoring_initialization_state");
if (!contentJs.includes('ui.importLocal.textContent = canReimport || retryStandardImport ? "重新导入"')) throw new Error("content_missing_compact_import_retry_launcher");
if (!contentJs.includes("captureClickedParagraph") || !contentJs.includes("event.ctrlKey")) throw new Error("content_missing_ctrl_click_paragraph_capture");
if (!contentJs.includes("mark && draft && (event.altKey || event.metaKey)")) throw new Error("content_missing_alt_merge_gesture");
if (!contentJs.includes('type: standardize ? "draft-import-local" : force ? "draft-resubmit" : "draft-submit"')) throw new Error("content_missing_standard_import_transport");
if (!contentJs.includes('message?.type === "context-import-current-page"')) throw new Error("content_missing_context_page_import_message");
if (!contentJs.includes('message?.type === "context-import-progress"')) throw new Error("content_missing_context_import_feedback");
if (!contentJs.includes("重新导入")) throw new Error("content_missing_locked_draft_reimport");
if (!contentJs.includes("加工模式") || !contentJs.includes("挖空模式")) throw new Error("content_missing_dual_authoring_modes");
if (!contentJs.includes('MODE_KEY = "localIrAuthoringMode"')) throw new Error("content_missing_global_mode_key");
for (const label of ["仅高亮", "普通评论", "迷思 / 真相", "反驳", "引用", "稍后处理", "改写", "精炼", "联想", "反驳后改写", "提问", "优化", "例子与观点", "问答卡"]) {
  if (!contentJs.includes(label)) throw new Error(`content_missing_annotation_label:${label}`);
}
if (!contentJs.includes('if (!draft || draft.locked || authoringMode === "off") return;')) {
  throw new Error("content_selection_must_require_initialized_active_mode");
}

const appJs = await fs.readFile(path.join(workflowRoot, "scripts", "progressive-reading-app.mjs"), "utf8");
if (!appJs.includes("/browser-highlight-test")) throw new Error("app_missing_browser_highlight_test_route");
if (!appJs.includes("browser_page_highlight")) throw new Error("app_missing_full_page_highlight_mode");
if (!appJs.includes("Readability")) throw new Error("app_missing_readability_conversion");
if (!appJs.includes("/api/highlights/commit")) throw new Error("app_missing_browser_commit_route");
if (!appJs.includes("/api/highlights/complete")) throw new Error("app_missing_browser_complete_route");
if (!appJs.includes("/api/highlights/import-local")) throw new Error("app_missing_browser_standard_import_route");
if (!appJs.includes("/api/highlights/import-local-urls")) throw new Error("app_missing_batch_standard_import_route");
if (!appJs.includes("/api/browser-import/requests") || !appJs.includes("/api/browser-import/tasks/claim")) throw new Error("app_missing_browser_import_broker_routes");
if (!appJs.includes("preprocessBrowserCapture")) throw new Error("app_missing_standard_preprocess_interface");
if (!appJs.includes("withBrowserCommitLock")) throw new Error("app_missing_same_url_commit_serialization");
if (!appJs.includes("browserStateRoot") || !appJs.includes("browser-document-state")) throw new Error("app_missing_internal_browser_state_root");
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
