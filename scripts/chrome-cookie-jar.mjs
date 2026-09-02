import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const CHROME_COOKIE_JAR_SYNC_SCHEMA = "local-ir.chrome-cookie-jar-sync/v1";
export const CHROME_COOKIE_SNAPSHOT_SCHEMA = "local.chrome-cookie-snapshot";
export const CHROME_COOKIE_SNAPSHOT_SCHEMA_VERSION = 1;
export const CHROME_COOKIE_SNAPSHOT_PATH_ENV = "PROGRESSIVE_READING_COOKIE_SNAPSHOT_PATH";
export const CHROME_COOKIE_JAR_MAX_COOKIES = 50_000;
export const CHROME_COOKIE_JAR_MAX_SYNC_BYTES = 32 * 1024 * 1024;
export const CHROME_COOKIE_JAR_MAX_HEADER_BYTES = 64 * 1024;

const SAME_SITE_VALUES = new Set(["no_restriction", "lax", "strict", "unspecified"]);
const REQUIRED_COOKIE_KEYS = Object.freeze([
  "name",
  "value",
  "domain",
  "hostOnly",
  "path",
  "secure",
  "httpOnly",
  "sameSite",
  "session",
  "expirationDate",
  "storeId"
]);
const OPTIONAL_COOKIE_KEYS = new Set(["partitionKey"]);
const SNAPSHOT_ROOT_KEYS = new Set([
  "schema",
  "schemaVersion",
  "sensitivity",
  "snapshotId",
  "generatedAt",
  "producer",
  "profile",
  "cookies"
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredBoolean(value, code) {
  if (typeof value !== "boolean") throw new Error(code);
  return value;
}

function normalizedDomain(value, hostOnly) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw.includes("*") || /[\s/:?#@]/u.test(raw)) throw new Error("chrome_cookie_domain_invalid");
  if (hostOnly && raw.startsWith(".")) throw new Error("chrome_cookie_host_only_domain_must_not_have_dot");
  const domain = raw.replace(/^\./u, "");
  let parsed;
  try {
    parsed = new URL(`https://${domain}/`).hostname.toLowerCase();
  } catch {
    throw new Error("chrome_cookie_domain_invalid");
  }
  if (parsed !== domain) throw new Error("chrome_cookie_domain_invalid");
  return domain;
}

function normalizedCookie(cookie, index, nowSeconds) {
  if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) throw new Error(`chrome_cookie_object_required:${index}`);
  const keys = Object.keys(cookie);
  for (const key of REQUIRED_COOKIE_KEYS) {
    if (!Object.hasOwn(cookie, key)) throw new Error(`chrome_cookie_field_required:${key}:${index}`);
  }
  if (keys.some((key) => !REQUIRED_COOKIE_KEYS.includes(key) && !OPTIONAL_COOKIE_KEYS.has(key))) {
    throw new Error(`chrome_cookie_unknown_field:${index}`);
  }
  const partitioned = cookie.partitionKey !== undefined && cookie.partitionKey !== null;

  const name = String(cookie.name ?? "");
  const value = String(cookie.value ?? "");
  if (!name || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name)) throw new Error(`chrome_cookie_name_invalid:${index}`);
  if (/[;\r\n\0]/u.test(value)) throw new Error(`chrome_cookie_value_invalid:${index}`);
  if (Buffer.byteLength(`${name}=${value}`, "utf8") > 8192) throw new Error(`chrome_cookie_pair_too_large:${index}`);

  const hostOnly = requiredBoolean(cookie.hostOnly, `chrome_cookie_host_only_invalid:${index}`);
  const domain = normalizedDomain(cookie.domain, hostOnly);
  const cookiePath = String(cookie.path || "");
  if (!cookiePath.startsWith("/") || /[\r\n\0]/u.test(cookiePath) || Buffer.byteLength(cookiePath, "utf8") > 4096) {
    throw new Error(`chrome_cookie_path_invalid:${index}`);
  }
  const secure = requiredBoolean(cookie.secure, `chrome_cookie_secure_invalid:${index}`);
  const httpOnly = requiredBoolean(cookie.httpOnly, `chrome_cookie_http_only_invalid:${index}`);
  const session = requiredBoolean(cookie.session, `chrome_cookie_session_invalid:${index}`);
  const sameSite = String(cookie.sameSite || "");
  if (!SAME_SITE_VALUES.has(sameSite)) throw new Error(`chrome_cookie_same_site_invalid:${index}`);
  const storeId = String(cookie.storeId ?? "");
  if (!storeId || Buffer.byteLength(storeId, "utf8") > 128 || /[\r\n\0]/u.test(storeId)) throw new Error(`chrome_cookie_store_id_invalid:${index}`);

  let expirationDate = null;
  let expired = false;
  if (session) {
    if (cookie.expirationDate !== null) throw new Error(`chrome_cookie_session_expiration_must_be_null:${index}`);
  } else {
    expirationDate = Number(cookie.expirationDate);
    if (!Number.isFinite(expirationDate) || expirationDate <= 0) throw new Error(`chrome_cookie_expiration_invalid:${index}`);
    expired = expirationDate <= nowSeconds;
  }
  if (partitioned) return { skipped: "partitioned" };
  if (expired) return { skipped: "expired" };

  return {
    cookie: {
      name,
      value,
      domain,
      hostOnly,
      path: cookiePath,
      secure,
      httpOnly,
      sameSite,
      session,
      expirationDate,
      storeId
    }
  };
}

function cookieIdentity(cookie) {
  return `${cookie.storeId}\n${cookie.domain}\n${cookie.hostOnly ? "host_only" : "domain_scoped"}\n${cookie.path}\n${cookie.name}`;
}

function canonicalCookie(cookie) {
  return JSON.stringify([
    cookie.name,
    cookie.value,
    cookie.domain,
    cookie.hostOnly,
    cookie.path,
    cookie.secure,
    cookie.httpOnly,
    cookie.sameSite,
    cookie.session,
    cookie.expirationDate,
    cookie.storeId
  ]);
}

export function validateChromeCookieJarPayload(payload, { nowSeconds = Date.now() / 1000 } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("chrome_cookie_sync_payload_object_required");
  const rootKeys = Object.keys(payload);
  if (rootKeys.length !== 2 || rootKeys.some((key) => !new Set(["schema", "cookies"]).has(key))) {
    throw new Error("chrome_cookie_sync_payload_fields_invalid");
  }
  if (payload.schema !== CHROME_COOKIE_JAR_SYNC_SCHEMA) throw new Error("chrome_cookie_sync_schema_invalid");
  if (!Array.isArray(payload.cookies)) throw new Error("chrome_cookie_sync_cookies_array_required");
  if (payload.cookies.length > CHROME_COOKIE_JAR_MAX_COOKIES) throw new Error("chrome_cookie_sync_too_many_cookies");

  const accepted = new Map();
  let skippedPartitioned = 0;
  let skippedExpired = 0;
  for (let index = 0; index < payload.cookies.length; index += 1) {
    const normalized = normalizedCookie(payload.cookies[index], index, nowSeconds);
    if (normalized.skipped === "partitioned") {
      skippedPartitioned += 1;
      continue;
    }
    if (normalized.skipped === "expired") {
      skippedExpired += 1;
      continue;
    }
    const identity = cookieIdentity(normalized.cookie);
    if (accepted.has(identity)) throw new Error(`chrome_cookie_sync_duplicate_identity:${index}`);
    accepted.set(identity, normalized.cookie);
  }
  const cookies = [...accepted.values()].sort((left, right) => cookieIdentity(left).localeCompare(cookieIdentity(right)));
  const fingerprint = `sha256:${sha256(cookies.map(canonicalCookie).join("\n"))}`;
  return {
    cookies,
    cookieCount: cookies.length,
    domainCount: new Set(cookies.map((cookie) => cookie.domain)).size,
    skippedPartitioned,
    skippedExpired,
    skippedCount: skippedPartitioned + skippedExpired,
    fingerprint
  };
}

export function validateChromeCookieSnapshot(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("snapshot_root_object_required");
  const rootKeys = Object.keys(payload);
  if (rootKeys.length !== SNAPSHOT_ROOT_KEYS.size || rootKeys.some((key) => !SNAPSHOT_ROOT_KEYS.has(key))) {
    throw new Error("snapshot_root_fields_invalid");
  }
  if (payload.schema !== CHROME_COOKIE_SNAPSHOT_SCHEMA) throw new Error("snapshot_schema_unsupported");
  if (payload.schemaVersion !== CHROME_COOKIE_SNAPSHOT_SCHEMA_VERSION) throw new Error("snapshot_schema_version_unsupported");
  if (payload.sensitivity !== "local_sensitive_credential") throw new Error("snapshot_sensitivity_invalid");
  if (typeof payload.snapshotId !== "string" || !payload.snapshotId.trim()) throw new Error("snapshot_id_invalid");
  if (typeof payload.generatedAt !== "string" || !Number.isFinite(Date.parse(payload.generatedAt))) {
    throw new Error("snapshot_generated_at_invalid");
  }
  if (payload.producer?.name !== "chrome-cookie-sync-extension"
    || typeof payload.producer?.version !== "string"
    || payload.producer?.api !== "chrome.cookies.getAll"
    || payload.producer?.partitionQuery !== "all_partition_keys") {
    throw new Error("snapshot_producer_invalid");
  }
  if (payload.profile?.browser !== "Google Chrome" || payload.profile?.scope !== "current_regular_profile") {
    throw new Error("snapshot_profile_invalid");
  }
  if (!Array.isArray(payload.profile?.storeIds)
    || payload.profile.storeIds.some((storeId) => typeof storeId !== "string" || !storeId)) {
    throw new Error("snapshot_store_ids_invalid");
  }
  if (!Array.isArray(payload.cookies)) throw new Error("snapshot_cookies_array_required");
  const declaredStores = new Set(payload.profile.storeIds);
  if (payload.cookies.some((cookie) => !declaredStores.has(String(cookie?.storeId ?? "")))) {
    throw new Error("snapshot_cookie_store_not_declared");
  }
  return payload;
}

export function parseChromeCookieSnapshot(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    throw new Error("snapshot_json_invalid");
  }
  return validateChromeCookieSnapshot(parsed);
}

function domainMatches(hostname, cookie) {
  if (cookie.hostOnly) return hostname === cookie.domain;
  return hostname === cookie.domain || hostname.endsWith(`.${cookie.domain}`);
}

function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith("/")) return true;
  return requestPath[cookiePath.length] === "/";
}

export function validateChromeCookieSyncOrigin(value) {
  const origin = String(value || "").trim();
  if (!origin || origin.includes(",")) throw new Error("cookie_sync_origin_required");
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("cookie_sync_origin_invalid");
  }
  if (parsed.protocol !== "chrome-extension:"
    || !/^[a-p]{32}$/u.test(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash
    || parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new Error("cookie_sync_origin_not_allowed");
  }
  return `chrome-extension://${parsed.hostname}`;
}

export class ChromeCookieJar {
  constructor() {
    this.cookies = [];
    this.health = {
      schema: CHROME_COOKIE_JAR_SYNC_SCHEMA,
      configured: false,
      cookie_count: 0,
      domain_count: 0,
      skipped_count: 0,
      skipped_partitioned_count: 0,
      skipped_expired_count: 0,
      fingerprint: `sha256:${sha256("")}`,
      source: "none",
      values_exposed: false
    };
  }

  replace(payload, options = {}) {
    const validated = validateChromeCookieJarPayload(payload, options);
    this.cookies = validated.cookies;
    this.health = {
      schema: CHROME_COOKIE_JAR_SYNC_SCHEMA,
      configured: true,
      cookie_count: validated.cookieCount,
      domain_count: validated.domainCount,
      skipped_count: validated.skippedCount,
      skipped_partitioned_count: validated.skippedPartitioned,
      skipped_expired_count: validated.skippedExpired,
      fingerprint: validated.fingerprint,
      source: "runtime_payload",
      values_exposed: false
    };
    return { ...this.health };
  }

  replaceSnapshot(snapshot, options = {}) {
    const validatedSnapshot = validateChromeCookieSnapshot(snapshot);
    const health = this.replace({
      schema: CHROME_COOKIE_JAR_SYNC_SCHEMA,
      cookies: validatedSnapshot.cookies
    }, options);
    this.health = {
      ...health,
      source: "versioned_local_snapshot",
      source_schema: CHROME_COOKIE_SNAPSHOT_SCHEMA,
      source_schema_version: CHROME_COOKIE_SNAPSHOT_SCHEMA_VERSION,
      snapshot_generated_at: validatedSnapshot.generatedAt,
      snapshot_cookie_count: validatedSnapshot.cookies.length,
      snapshot_id_fingerprint: `sha256:${sha256(validatedSnapshot.snapshotId)}`,
      values_exposed: false
    };
    return { ...this.health };
  }

  async loadSnapshotFile(snapshotPath, options = {}) {
    const resolvedPath = path.resolve(String(snapshotPath || ""));
    if (!snapshotPath || !path.isAbsolute(String(snapshotPath))) throw new Error("snapshot_path_absolute_required");
    const metadata = await fs.stat(resolvedPath).catch((error) => {
      if (error?.code === "ENOENT") throw new Error("snapshot_file_not_found");
      throw new Error("snapshot_file_stat_failed");
    });
    if (!metadata.isFile()) throw new Error("snapshot_path_not_file");
    if (metadata.size <= 0 || metadata.size > CHROME_COOKIE_JAR_MAX_SYNC_BYTES) throw new Error("snapshot_file_size_invalid");
    let text;
    try {
      text = await fs.readFile(resolvedPath, "utf8");
    } catch {
      throw new Error("snapshot_file_read_failed");
    }
    if (Buffer.byteLength(text, "utf8") > CHROME_COOKIE_JAR_MAX_SYNC_BYTES) throw new Error("snapshot_file_size_invalid");
    return this.replaceSnapshot(parseChromeCookieSnapshot(text), options);
  }

  headerForUrl(value, { nowSeconds = Date.now() / 1000 } = {}) {
    let url;
    try {
      url = new URL(String(value || ""));
    } catch {
      throw new Error("chrome_cookie_request_url_invalid");
    }
    if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("chrome_cookie_request_scheme_invalid");
    const hostname = url.hostname.toLowerCase();
    const requestPath = url.pathname || "/";
    const matches = this.cookies.filter((cookie) => domainMatches(hostname, cookie)
      && pathMatches(requestPath, cookie.path)
      && (!cookie.secure || url.protocol === "https:")
      && (cookie.session || cookie.expirationDate > nowSeconds));
    matches.sort((left, right) => right.path.length - left.path.length
      || Number(right.hostOnly) - Number(left.hostOnly)
      || right.domain.length - left.domain.length
      || left.name.localeCompare(right.name)
      || left.storeId.localeCompare(right.storeId));
    const header = matches.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    if (Buffer.byteLength(header, "utf8") > CHROME_COOKIE_JAR_MAX_HEADER_BYTES) throw new Error("chrome_cookie_header_too_large");
    return header || null;
  }
}

export function chromeCookieJarMatchingStatistics(jar) {
  if (!(jar instanceof ChromeCookieJar)) throw new Error("chrome_cookie_jar_required");
  let selfProbeWithMatch = 0;
  let selfProbeHeaderOverflow = 0;
  for (const cookie of jar.cookies) {
    const scheme = cookie.secure ? "https" : "http";
    const probeUrl = `${scheme}://${cookie.domain}${cookie.path}`;
    try {
      if (jar.headerForUrl(probeUrl)) selfProbeWithMatch += 1;
    } catch (error) {
      if (error?.message === "chrome_cookie_header_too_large") selfProbeHeaderOverflow += 1;
      else throw error;
    }
  }
  return {
    accepted_cookie_count: jar.cookies.length,
    host_only_count: jar.cookies.filter((cookie) => cookie.hostOnly).length,
    domain_scoped_count: jar.cookies.filter((cookie) => !cookie.hostOnly).length,
    secure_count: jar.cookies.filter((cookie) => cookie.secure).length,
    session_count: jar.cookies.filter((cookie) => cookie.session).length,
    self_probe_count: jar.cookies.length,
    self_probe_with_match_count: selfProbeWithMatch,
    self_probe_header_overflow_count: selfProbeHeaderOverflow,
    values_exposed: false,
    network_requests: 0
  };
}
