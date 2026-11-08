import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LiveCookieSnapshot, COOKIE_SYNC_EXTENSION_ID, LIVE_COOKIE_MAX_AGE_MS, safeError } from "./live-cookie-snapshot.mjs";
const origin = `chrome-extension://${COOKIE_SYNC_EXTENSION_ID}`;
const outputRoot = "D:/Artifacts/ProgressiveReading/auth-tests";
test("indexed validation errors retain the safe reason without exposing input", () => {
  assert.equal(safeError(new Error("chrome_cookie_name_invalid:123")), "chrome_cookie_name_invalid");
  assert.equal(safeError(new Error("chrome_cookie_field_required:value:123")), "chrome_cookie_field_required");
  assert.equal(safeError(new Error("private arbitrary message")), "cookie_sync_storage_unavailable");
});
await fs.mkdir(outputRoot, { recursive: true });
function snapshot(now, value = "synthetic-a") {
  return { schema: "local.chrome-cookie-snapshot", schemaVersion: 1, sensitivity: "local_sensitive_credential", snapshotId: randomUUID(), generatedAt: new Date(now).toISOString(),
    producer: { name: "chrome-cookie-sync-extension", version: "1.1.0", api: "chrome.cookies.getAll", partitionQuery: "all_partition_keys" },
    profile: { browser: "Google Chrome", scope: "current_regular_profile", storeIds: ["0"] },
    cookies: value === null ? [] : [{ name: "session", value, domain: ".example.test", hostOnly: false, path: "/", secure: true, httpOnly: true, sameSite: "lax", session: true, expirationDate: null, storeId: "0", partitionKey: null }] };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(outputRoot, "fixture-")); let now = Date.now();
  const options = { workflowRoot: path.join(root, "workflow"), dataRoot: path.join(root, "credentials"), now: () => now };
  await fs.mkdir(path.join(options.workflowRoot, ".local-ir"), { recursive: true });
  return { root, options, source: new LiveCookieSnapshot(options), now: () => now, advance: ms => { now += ms; } };
}

test("Chrome value-only cookies survive sync without an invented equals prefix", async () => {
  const f = await fixture(); const input = snapshot(f.now());
  input.cookies.push({ ...input.cookies[0], name: "", value: "value-only" });
  await f.source.accept(input, origin);
  const header = f.source.headerForUrl("https://www.example.test/");
  assert.ok(header.split("; ").includes("value-only"));
  assert.ok(header.split("; ").includes("session=synthetic-a"));
  input.cookies[1].value = "other=credential";
  await assert.rejects(f.source.accept(input, origin), /chrome_cookie_empty_name_ambiguous/);
  input.cookies[1].name = "bad\r\nname";
  await assert.rejects(f.source.accept(input, origin), /chrome_cookie_name_invalid/);
});

test("Chromium names outside RFC token grammar preserve exact names and reject delimiters", async () => {
  const f = await fixture(); const input = snapshot(f.now());
  input.cookies = ["site:key", "path/key", "two words", "[key]"].map(name => ({ ...input.cookies[0], name }));
  await f.source.accept(input, origin);
  const parts = f.source.headerForUrl("https://www.example.test/").split("; ");
  for (const cookie of input.cookies) assert.ok(parts.includes(`${cookie.name}=${cookie.value}`));
  for (const name of ["key;injected", "key=injected", "key\tname", "key\x7f"]) {
    const invalid = snapshot(f.now()); invalid.cookies[0].name = name;
    await assert.rejects(f.source.accept(invalid, origin), /chrome_cookie_name_invalid/);
  }
});

test("direct Node startup reads legacy pointer; hot reload follows updates and removes lost credentials", async () => {
  const f = await fixture(); const file = path.join(f.root, "manual.json");
  await fs.writeFile(f.source.pointerPath, file); f.source.refresh({ force: true });
  assert.equal(f.source.health().error, "snapshot_file_not_found");
  await fs.writeFile(file, JSON.stringify(snapshot(f.now()))); f.source.refresh({ force: true });
  assert.equal(f.source.headerForUrl("https://www.example.test/"), "session=synthetic-a");
  await fs.writeFile(file, JSON.stringify(snapshot(f.now(), "synthetic-b"))); f.source.refresh({ force: true });
  assert.equal(f.source.headerForUrl("https://www.example.test/"), "session=synthetic-b");
  await fs.unlink(file); f.source.refresh({ force: true }); assert.equal(f.source.headerForUrl("https://www.example.test/"), null);
  assert.ok(!JSON.stringify(f.source.health()).includes(file));
});

test("managed sync survives restart, overrides broken pointer, and propagates logout", async () => {
  const f = await fixture(); await fs.writeFile(f.source.pointerPath, path.join(f.root, "missing.json"));
  const receipt = await f.source.accept(snapshot(f.now()), origin);
  assert.equal(receipt.status, "synchronized"); assert.equal(receipt.resync_required_after_restart, false);
  const restarted = new LiveCookieSnapshot(f.options);
  assert.equal(restarted.headerForUrl("https://www.example.test/"), "session=synthetic-a");
  f.advance(1000); await f.source.accept(snapshot(f.now(), null), origin);
  restarted.refresh({ force: true }); assert.equal(restarted.headerForUrl("https://www.example.test/"), null);
  assert.equal(restarted.health().loaded, true); assert.equal(restarted.health().cookie_count, 0);
});

test("wrong extension, stale or out-of-order snapshots cannot replace active credentials", async () => {
  const f = await fixture(); await f.source.accept(snapshot(f.now()), origin);
  await assert.rejects(f.source.accept(snapshot(f.now()), `chrome-extension://${"a".repeat(32)}`), /origin_not_allowed/);
  await assert.rejects(f.source.accept(snapshot(f.now() - 1000), origin), /out_of_order/);
  await assert.rejects(f.source.accept(snapshot(f.now() - 600_000), origin), /not_recent/);
  assert.equal(f.source.headerForUrl("https://www.example.test/"), "session=synthetic-a");
  assert.equal(f.source.headerForUrl("http://www.example.test/"), null);
  assert.equal(f.source.headerForUrl("https://other.test/"), null);
});

test("deleting a live snapshot never revives an older manual login, even after restart", async () => {
  const f = await fixture(); const manual = path.join(f.root, "old-manual.json");
  await fs.writeFile(manual, JSON.stringify(snapshot(f.now(), "old-login")));
  await fs.writeFile(f.source.pointerPath, manual);
  await f.source.accept(snapshot(f.now()), origin);
  await fs.unlink(f.source.livePath);
  f.source.refresh({ force: true }); assert.equal(f.source.headerForUrl("https://example.test/"), null);
  const restarted = new LiveCookieSnapshot(f.options);
  assert.equal(restarted.headerForUrl("https://example.test/"), null);
  assert.equal(restarted.health().error, "snapshot_file_not_found");
});

test("invalid snapshots fail atomically; malformed disk content clears old in-memory credentials", async () => {
  const f = await fixture(); await f.source.accept(snapshot(f.now()), origin);
  const invalid = snapshot(f.now()); invalid.cookies[0].domain = "invalid/domain";
  await assert.rejects(f.source.accept(invalid, origin)); assert.equal(f.source.health().loaded, true);
  await fs.writeFile(f.source.livePath, "not json"); f.source.refresh({ force: true });
  assert.equal(f.source.health().loaded, false); assert.equal(f.source.headerForUrl("https://example.test/"), null);
  assert.ok(!JSON.stringify(f.source.health()).includes("synthetic-a"));
});

test("missed Chrome heartbeats expire the managed view and a fresh snapshot restores it", async () => {
  const f = await fixture(); await f.source.accept(snapshot(f.now()), origin);
  f.advance(LIVE_COOKIE_MAX_AGE_MS + 1);
  assert.throws(() => f.source.headerForUrl("https://example.test/"), /cookie_sync_stale_refresh_chrome/);
  assert.equal(f.source.health().status, "stale");
  await f.source.accept(snapshot(f.now(), "renewed"), origin);
  assert.equal(f.source.headerForUrl("https://example.test/"), "session=renewed");
});

test("stale credentials only block matching origins and paths, leaving unrelated public reads available", async () => {
  const f = await fixture(); const input = snapshot(f.now());
  input.cookies[0].path = "/private";
  await f.source.accept(input, origin);
  f.advance(LIVE_COOKIE_MAX_AGE_MS + 1);
  assert.equal(f.source.headerForUrl("https://independent.test/article"), null);
  assert.equal(f.source.headerForUrl("https://example.test/public"), null);
  assert.throws(() => f.source.headerForUrl("https://example.test/private/article"), /cookie_sync_stale_refresh_chrome/);
  assert.equal(f.source.health().status, "stale");
});
