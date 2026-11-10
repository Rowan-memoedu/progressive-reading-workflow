import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from 'node:util';
import { randomUUID } from "node:crypto";
import { dataPath } from './runtime-paths.mjs';
import { ChromeCookieJar, parseChromeCookieSnapshot, CHROME_COOKIE_JAR_MAX_SYNC_BYTES } from "./chrome-cookie-jar.mjs";
const execute=promisify(execFile);

export const COOKIE_SYNC_EXTENSION_ID = "kkhdelnhoaagpbmgicmdljmplodkioop";
export const COOKIE_SNAPSHOT_ENDPOINT = "/api/browser-import/cookies/snapshot";
export const COOKIE_STATUS_ENDPOINT = "/api/browser-import/cookies/status";
export const LIVE_COOKIE_MAX_AGE_MS = 15 * 60_000;

// This directory is outside the workflow's file-serving and Git roots.
export function defaultCookieDataRoot(workflowRoot, env = process.env) {
  if (env.PROGRESSIVE_READING_COOKIE_DATA_ROOT) return path.resolve(env.PROGRESSIVE_READING_COOKIE_DATA_ROOT);
  if (env.NODE_ENV === "test") return path.join(workflowRoot, ".local-ir", "synthetic-credentials");
  return dataPath('ProgressiveReading', 'BrowserAuth');
}

export function safeError(error) {
  const code = String(error?.message || "").split(":", 1)[0];
  return /^(?:snapshot|chrome_cookie|cookie_sync)_[a-z0-9_]+$/u.test(code) ? code : "cookie_sync_storage_unavailable";
}

export class LiveCookieSnapshot {
  constructor({ jar = new ChromeCookieJar(), workflowRoot, dataRoot, explicitPath = "", now = Date.now }) {
    this.jar = jar;
    this.dataRoot = path.resolve(dataRoot);
    this.livePath = path.join(this.dataRoot, "chrome-current.json");
    this.modePath = path.join(this.dataRoot, "live-sync.enabled");
    this.liveSelected = false;
    this.pointerPath = path.join(workflowRoot, ".local-ir", "cookie-snapshot.path");
    this.explicitPath = String(explicitPath).trim();
    this.now = now;
    this.nextCheck = 0;
    this.signature = null;
    this.activePath = null;
    this.error = null;
    this.queue = Promise.resolve();
  }

  resolvePath() {
    if (this.explicitPath) {
      if (!path.isAbsolute(this.explicitPath)) throw new Error("snapshot_path_absolute_required");
      return this.explicitPath;
    }
    if (this.liveSelected || fs.existsSync(this.modePath) || fs.existsSync(this.livePath)) {
      this.liveSelected = true;
      return this.livePath;
    }
    if (!fs.existsSync(this.pointerPath)) return null;
    const value = fs.readFileSync(this.pointerPath, "utf8").trim();
    if (!value || !path.isAbsolute(value)) throw new Error("snapshot_path_absolute_required");
    return value;
  }

  refresh({ force = false } = {}) {
    if (!force && this.now() < this.nextCheck) return;
    this.nextCheck = this.now() + 1000;
    try {
      const source = this.resolvePath();
      this.activePath = source;
      if (!source) { this.clear(); return; }
      let stat;
      try { stat = fs.statSync(source); } catch { throw new Error("snapshot_file_not_found"); }
      if (!stat.isFile() || stat.size <= 0 || stat.size > CHROME_COOKIE_JAR_MAX_SYNC_BYTES) throw new Error("snapshot_file_size_invalid");
      const signature = `${source}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      if (signature !== this.signature) {
        const snapshot = parseChromeCookieSnapshot(fs.readFileSync(source, "utf8"));
        this.jar.replaceSnapshot(snapshot, { nowSeconds: this.now() / 1000 });
        this.signature = signature;
      }
      this.error = null;
    } catch (error) {
      // Do not keep sending a deleted or malformed credential snapshot.
      this.clear(safeError(error));
    }
  }

  clear(error = null) {
    const empty = new ChromeCookieJar();
    this.jar.cookies = empty.cookies;
    this.jar.health = empty.health;
    this.signature = null;
    this.error = error;
  }

  health() {
    const generated = Date.parse(this.jar.health.snapshot_generated_at || "");
    const ageMs = Number.isFinite(generated) ? Math.max(0, this.now() - generated) : null;
    const managed = this.activePath === this.livePath;
    const stale = managed && ageMs !== null && ageMs > LIVE_COOKIE_MAX_AGE_MS;
    return {
      configured: Boolean(this.activePath),
      loaded: this.jar.health.configured && !stale,
      status: this.error ? "unavailable" : stale ? "stale" : this.jar.health.configured ? "loaded" : "not_configured",
      mode: managed ? "chrome_live_sync" : this.activePath ? "manual_snapshot" : "awaiting_chrome_sync",
      error: this.error,
      last_sync_at: this.jar.health.snapshot_generated_at || null,
      age_seconds: ageMs === null ? null : Math.floor(ageMs / 1000),
      max_live_age_seconds: LIVE_COOKIE_MAX_AGE_MS / 1000,
      cookie_count: this.jar.cookies.filter(cookie => cookie.session || cookie.expirationDate > this.now() / 1000).length,
      domain_count: this.jar.health.domain_count,
      cookie_values_exposed: false,
      hot_reload: true,
      login_verified: false
    };
  }

  headerForUrl(url) {
    this.refresh();
    const header = this.jar.headerForUrl(url, { nowSeconds: this.now() / 1000 });
    // Unrelated sites and paths have no credential from this snapshot to age out.
    if (header && this.health().status === "stale") throw new Error("cookie_sync_stale_refresh_chrome");
    return header;
  }

  validateOrigin(origin) {
    if (origin !== `chrome-extension://${COOKIE_SYNC_EXTENSION_ID}`) throw new Error("cookie_sync_origin_not_allowed");
  }

  async protectDirectory() {
    await fsp.mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") {
      const {stdout:identity} = await execute("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout:15000 });
      const sid = identity.match(/S-1-5-\d+(?:-\d+)+/u)?.[0];
      if (!sid) throw new Error("cookie_sync_storage_acl_failed");
      try {
        await execute("icacls.exe", [this.dataRoot, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { windowsHide: true, timeout:15000 });
      } catch { throw new Error("cookie_sync_storage_acl_failed"); }
    }
  }

  accept(snapshot, origin) {
    const operation = this.queue.catch(() => {}).then(async () => {
      this.validateOrigin(origin);
      if (this.explicitPath) throw new Error("cookie_sync_manual_snapshot_mode");
      // Validate in a separate jar before writing or changing the live one.
      const candidate = new ChromeCookieJar();
      candidate.replaceSnapshot(snapshot, { nowSeconds: this.now() / 1000 });
      const generated = Date.parse(snapshot.generatedAt);
      if (generated > this.now() + 30_000 || generated < this.now() - 5 * 60_000) throw new Error("cookie_sync_snapshot_not_recent");
      this.refresh({ force: true });
      if (this.activePath === this.livePath && generated < Date.parse(this.jar.health.snapshot_generated_at || "")) throw new Error("cookie_sync_snapshot_out_of_order");
      const encoded = JSON.stringify(snapshot);
      if (Buffer.byteLength(encoded) > CHROME_COOKIE_JAR_MAX_SYNC_BYTES) throw new Error("snapshot_file_size_invalid");
      const temporary = path.join(this.dataRoot, `.${randomUUID()}.tmp`);
      try {
        await this.protectDirectory();
        await fsp.writeFile(temporary, encoded, { mode: 0o600, flag: "wx" });
        // Persist source selection so deleting the live file never resurrects
        // an old downloaded snapshot, including after a service restart.
        await fsp.writeFile(this.modePath, "chrome_live_sync\n", { mode: 0o600 });
        await fsp.rename(temporary, this.livePath);
      } catch (error) { throw new Error(safeError(error)); }
      finally { await fsp.unlink(temporary).catch(() => {}); }
      this.signature = null;
      this.refresh({ force: true });
      if (!this.health().loaded) throw new Error("cookie_sync_persisted_snapshot_unavailable");
      return { ...this.health(), status: "synchronized", persistence: "local_credential_file", resync_required_after_restart: false };
    });
    this.queue = operation;
    return operation;
  }
}
