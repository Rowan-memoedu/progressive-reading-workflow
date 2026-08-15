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

async function createHarness({ existingDraft = false } = {}) {
  const dom = new JSDOM("<!doctype html><html><head><title>Fixture</title></head><body><article><p>Alpha beta gamma.</p></article></body></html>", {
    url: "https://local.test/article",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const { window } = dom;
  const storage = { localIrAuthoringMode: "off", localIrHighlightEnabled: false };
  const storageListeners = [];
  let upsertCount = 0;
  let persistedDraft = null;
  window.eval(coreSource);
  if (existingDraft) {
    persistedDraft = window.LocalIrDraftCore.createDraft({
      url: window.location.href,
      title: window.document.title,
      pageText: "Alpha beta gamma.",
      sourceText: "Alpha beta gamma.",
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
        if (message.type === "draft-submit") return done({ ok: false, error: "submit_not_used_in_fixture" });
        return done({ ok: false, error: "unknown_message" });
      },
      onMessage: { addListener() {} }
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
    get upsertCount() { return upsertCount; }
  };
}

const fresh = await createHarness();
const freshRoot = fresh.host.shadowRoot;
assert.equal(fresh.upsertCount, 0, "opening a fresh page must not persist a draft");
assert.equal(freshRoot.querySelector(".initialize").hidden, false);
assert.equal(freshRoot.querySelector(".controls").hidden, true);

freshRoot.querySelector(".initialize").click();
await waitForUi();
assert.equal(fresh.upsertCount, 1, "manual initialization must persist exactly one draft");
assert.equal(freshRoot.querySelector(".initialize").hidden, true);
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

fresh.dom.window.close();
resumed.dom.window.close();

console.log(JSON.stringify({
  status: "passed",
  checks: [
    "fresh_page_no_auto_draft",
    "manual_initialization_single_write",
    "compact_preinit_launcher",
    "mutually_exclusive_global_modes",
    "mode_off_toggle",
    "existing_draft_auto_resume"
  ]
}, null, 2));
