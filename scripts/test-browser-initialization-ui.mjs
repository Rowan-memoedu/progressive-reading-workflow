import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.join(__dirname, "..", "browser-highlight-extension");
const [coreSource, contentSource] = await Promise.all([
  fs.readFile(path.join(extensionRoot, "draft-core.js"), "utf8"),
  fs.readFile(path.join(extensionRoot, "content.js"), "utf8")
]);

const waitForUi = () => new Promise((resolve) => setTimeout(resolve, 25));

async function createHarness({ existingDraft = false, standardImportFails = false } = {}) {
  const dom = new JSDOM("<!doctype html><html><head><title>Fixture</title></head><body><article><p>Alpha beta gamma.</p><p>Delta epsilon zeta.</p></article></body></html>", {
    url: "https://local.test/article",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const { window } = dom;
  const storage = { localIrAuthoringMode: "off", localIrHighlightEnabled: false };
  const storageListeners = [];
  const runtimeListeners = [];
  let upsertCount = 0;
  let discardCount = 0;
  let standardImportCount = 0;
  let standardImportDestination = null;
  let persistedDraft = null;
  window.eval(coreSource);
  if (existingDraft) {
    persistedDraft = window.LocalIrDraftCore.createDraft({
      url: window.location.href,
      title: window.document.title,
      pageText: "Alpha beta gamma.\n\nDelta epsilon zeta.",
      sourceText: "Alpha beta gamma.\n\nDelta epsilon zeta.",
      html: window.document.documentElement.outerHTML
    });
  }
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, done) {
        if (message.type === "draft-get") return done({ ok: true, draft: persistedDraft });
        if (message.type === "draft-upsert") {
          upsertCount += 1;
          persistedDraft = message.draft;
          return done({ ok: true, draft: persistedDraft });
        }
        if (message.type === "draft-discard") {
          discardCount += 1;
          persistedDraft = null;
          for (const listener of runtimeListeners) listener({ type: "draft-state", draft: null }, {}, () => {});
          return done({ ok: true, result: { discarded: true } });
        }
        if (message.type === "draft-import-local") {
          standardImportCount += 1;
          standardImportDestination = message.destination;
          persistedDraft.submitMode = "standard_preprocess";
          persistedDraft.submitDestination = "reading";
          if (standardImportFails) {
            persistedDraft = window.LocalIrDraftCore.markFailed(persistedDraft, "fixture_standard_import_failure");
            for (const listener of runtimeListeners) listener({ type: "draft-state", draft: persistedDraft }, {}, () => {});
            return done({ ok: false, error: "fixture_standard_import_failure" });
          }
          persistedDraft = window.LocalIrDraftCore.markSaved(persistedDraft, { status: "saved_locked" });
          return done({ ok: true, draft: persistedDraft, result: { status: "saved_locked" } });
        }
        if (message.type === "draft-submit") return done({ ok: false, error: "submit_not_used_in_fixture" });
        return done({ ok: false, error: "unknown_message" });
      },
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } }
    },
    storage: {
      local: {
        get(defaults, done) {
          done({ ...defaults, ...storage });
        },
        set(values, done = () => {}) {
          const changes = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { oldValue: storage[key], newValue: value };
            storage[key] = value;
          }
          done();
          for (const listener of storageListeners) listener(changes, "local");
        }
      },
      onChanged: { addListener(listener) { storageListeners.push(listener); } }
    }
  };
  window.eval(contentSource);
  await waitForUi();
  const host = window.document.querySelector("#local-ir-browser-workbench");
  assert.ok(host?.shadowRoot, "workbench must exist without creating a draft");
  return {
    dom,
    window,
    storage,
    host,
    async sendContentMessage(message) {
      return new Promise((resolve, reject) => {
        const listener = runtimeListeners[0];
        if (!listener) return reject(new Error("content_message_listener_missing"));
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) reject(new Error("content_message_response_timeout"));
        }, 1000);
        listener(message, {}, (response) => {
          settled = true;
          clearTimeout(timeout);
          resolve(response);
        });
      });
    },
    get upsertCount() { return upsertCount; },
    get discardCount() { return discardCount; },
    get standardImportCount() { return standardImportCount; },
    get standardImportDestination() { return standardImportDestination; },
    get persistedDraft() { return persistedDraft; }
  };
}

const fresh = await createHarness();
const freshRoot = fresh.host.shadowRoot;
assert.equal(fresh.upsertCount, 0, "opening a fresh page must not persist a draft");
assert.equal(freshRoot.querySelector(".initialize").hidden, false);
assert.equal(freshRoot.querySelector(".import-local").hidden, false);
assert.equal(freshRoot.querySelector(".controls").hidden, true);

freshRoot.querySelector(".initialize").click();
await waitForUi();
assert.equal(fresh.upsertCount, 1, "manual initialization must persist exactly one draft");
assert.equal(freshRoot.querySelector(".initialize").hidden, true);
assert.equal(freshRoot.querySelector(".import-local").hidden, true);
assert.equal(freshRoot.querySelector(".controls").hidden, false);

const processing = [...freshRoot.querySelectorAll("button")].find((button) => button.textContent === "加工模式");
const cloze = [...freshRoot.querySelectorAll("button")].find((button) => button.textContent === "挖空模式");
processing.click();
await waitForUi();
assert.equal(fresh.storage.localIrAuthoringMode, "processing");
assert.equal(processing.classList.contains("is-active"), true);
assert.equal(cloze.classList.contains("is-active"), false);

cloze.click();
await waitForUi();
assert.equal(fresh.storage.localIrAuthoringMode, "cloze");
assert.equal(processing.classList.contains("is-active"), false);
assert.equal(cloze.classList.contains("is-active"), true);

cloze.click();
await waitForUi();
assert.equal(fresh.storage.localIrAuthoringMode, "off");
assert.equal(fresh.upsertCount, 1, "mode switches must not create extra page drafts");

const resumed = await createHarness({ existingDraft: true });
assert.equal(resumed.upsertCount, 0, "an existing draft must resume without an extra write");
assert.equal(resumed.host.shadowRoot.querySelector(".initialize").hidden, true);
assert.equal(resumed.host.shadowRoot.querySelector(".controls").hidden, false);

const modifierClicks = await createHarness({ existingDraft: true });
const modifierRoot = modifierClicks.host.shadowRoot;
const modifierProcessing = [...modifierRoot.querySelectorAll("button")].find((button) => button.textContent === "加工模式");
modifierProcessing.click();
await waitForUi();
const paragraphs = [...modifierClicks.window.document.querySelectorAll("article > p")];
paragraphs[0].dispatchEvent(new modifierClicks.window.MouseEvent("click", { bubbles: true }));
await waitForUi();
assert.equal(modifierClicks.persistedDraft.annotations.length, 0, "plain paragraph click must not create a highlight");
paragraphs[0].dispatchEvent(new modifierClicks.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
await waitForUi();
assert.equal(modifierClicks.persistedDraft.annotations.length, 1, "Ctrl+click must highlight the whole first paragraph");
assert.equal(modifierClicks.persistedDraft.annotations[0].selectedText, "Alpha beta gamma.");
paragraphs[1].dispatchEvent(new modifierClicks.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
await waitForUi();
assert.equal(modifierClicks.persistedDraft.annotations.length, 2, "Ctrl+click must create a second whole-paragraph highlight");
const mergeMarks = [...modifierClicks.window.document.querySelectorAll("mark.local-ir-browser-highlight")];
assert.equal(mergeMarks.length, 2);
mergeMarks[0].dispatchEvent(new modifierClicks.window.MouseEvent("click", { bubbles: true, altKey: true }));
mergeMarks[1].dispatchEvent(new modifierClicks.window.MouseEvent("click", { bubbles: true, altKey: true }));
await waitForUi();
assert.equal(modifierClicks.persistedDraft.annotations.length, 1, "Alt+click must preserve the existing two-highlight merge behavior");

const modifierButtons = [...modifierRoot.querySelectorAll(".controls > button")];
const completeIndex = modifierButtons.findIndex((button) => button.textContent === "完成阅读");
const abandonIndex = modifierButtons.findIndex((button) => button.textContent === "放弃阅读");
assert.equal(abandonIndex, completeIndex + 1, "discard button must appear immediately after complete reading");
assert.equal(modifierButtons[abandonIndex].classList.contains("abandon"), true, "discard button must use the red abandon style");
modifierButtons[abandonIndex].click();
await waitForUi();
assert.equal(modifierClicks.discardCount, 1, "discard must delete the persisted browser draft exactly once");
assert.equal(modifierClicks.persistedDraft, null, "discard must clear the persisted browser draft");
assert.equal(modifierClicks.window.document.querySelectorAll("mark.local-ir-browser-highlight").length, 0, "discard must remove virtual highlights");
assert.equal(modifierRoot.querySelector(".initialize").hidden, false, "discard must restore the pre-initialization launcher");
assert.equal(modifierRoot.querySelector(".import-local").hidden, false);
assert.equal(modifierRoot.querySelector(".controls").hidden, true, "discard must collapse authoring controls");

const standardImport = await createHarness();
const standardImportRoot = standardImport.host.shadowRoot;
standardImportRoot.querySelector(".import-local").click();
await new Promise((resolve) => setTimeout(resolve, 75));
assert.equal(standardImport.upsertCount, 2, "standard import must initialize and persist before submission");
assert.equal(standardImport.standardImportCount, 1, "standard import must use the dedicated message exactly once");
assert.equal(standardImport.standardImportDestination, "reading", "standard import must always target the local reading area");
assert.equal(standardImportRoot.querySelector(".initialize").hidden, false, "direct import must not imply authoring initialization");
assert.equal(standardImportRoot.querySelector(".import-local").hidden, false);
assert.equal(standardImportRoot.querySelector(".import-local").textContent, "重新导入");
assert.equal(standardImportRoot.querySelector(".controls").hidden, true);
assert.match(standardImportRoot.querySelector(".status").textContent, /已保存并锁定/);

const failedStandardImport = await createHarness({ standardImportFails: true });
const failedStandardImportRoot = failedStandardImport.host.shadowRoot;
failedStandardImportRoot.querySelector(".import-local").click();
await new Promise((resolve) => setTimeout(resolve, 75));
assert.equal(failedStandardImport.standardImportCount, 1);
assert.equal(failedStandardImportRoot.querySelector(".initialize").hidden, false);
assert.equal(failedStandardImportRoot.querySelector(".import-local").hidden, false);
assert.equal(failedStandardImportRoot.querySelector(".import-local").textContent, "重新导入");
assert.equal(failedStandardImportRoot.querySelector(".controls").hidden, true, "failed direct import must not expose authoring controls");
failedStandardImportRoot.querySelector(".initialize").click();
await waitForUi();
assert.equal(failedStandardImportRoot.querySelector(".initialize").hidden, true);
assert.equal(failedStandardImportRoot.querySelector(".import-local").hidden, true);
assert.equal(failedStandardImportRoot.querySelector(".controls").hidden, false, "manual initialization must be the only action that exposes authoring controls");

const contextPageImport = await createHarness();
const contextPageResponse = await contextPageImport.sendContentMessage({ type: "context-import-current-page" });
assert.equal(contextPageResponse.ok, true, "current-page context action must report success");
assert.equal(contextPageImport.standardImportCount, 1, "current-page context action must reuse the standard import message");
assert.equal(contextPageImport.standardImportDestination, "reading");
assert.match(contextPageImport.host.shadowRoot.querySelector(".status").textContent, /已保存并锁定/);

const contextLinkFeedback = await createHarness();
await contextLinkFeedback.sendContentMessage({ type: "context-import-progress", phase: "started", message: "正在标准化并导入右键链接…" });
assert.match(contextLinkFeedback.window.document.querySelector("#local-ir-browser-toast").textContent, /正在标准化/);
await contextLinkFeedback.sendContentMessage({ type: "context-import-progress", phase: "succeeded", message: "链接已标准化并导入本地阅读区" });
assert.match(contextLinkFeedback.window.document.querySelector("#local-ir-browser-toast").textContent, /已标准化并导入/);

fresh.dom.window.close();
resumed.dom.window.close();
modifierClicks.dom.window.close();
standardImport.dom.window.close();
failedStandardImport.dom.window.close();
contextPageImport.dom.window.close();
contextLinkFeedback.dom.window.close();

console.log(JSON.stringify({
  status: "passed",
  checks: [
    "fresh_page_no_auto_draft",
    "manual_initialization_single_write",
    "standard_import_initializes_then_submits",
    "standard_import_always_targets_reading",
    "direct_import_does_not_initialize_authoring",
    "failed_import_retry_replaces_import_launcher",
    "failed_import_hides_authoring_controls",
    "manual_initialization_after_failure_exposes_authoring_controls",
    "context_page_reuses_standard_import",
    "context_link_progress_feedback",
    "compact_preinit_launcher",
    "mutually_exclusive_global_modes",
    "mode_off_toggle",
    "existing_draft_auto_resume",
    "plain_click_does_not_highlight_paragraph",
    "ctrl_click_highlights_whole_paragraph",
    "alt_click_preserves_merge",
    "discard_button_after_complete",
    "discard_clears_browser_draft_and_marks",
    "discard_restores_preinitialization_ui"
  ]
}, null, 2));
