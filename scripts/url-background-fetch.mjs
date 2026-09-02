import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";

export const BACKGROUND_FETCH_TRANSPORT = "background_fetch";
export const REQUIRES_BROWSER_AUTH = "requires_browser_auth";
export const REQUIRES_JS_RENDER = "requires_js_render";
export const URL_COOKIE_ENV = "PROGRESSIVE_READING_URL_COOKIE_MAP_JSON";
export const URL_COOKIE_SCHEMA = "local-ir.url-cookie-map/v1";
export const URL_COOKIE_SYNC_SCHEMA = "local-ir.url-cookie-sync/v1";
export const URL_COOKIE_SETUP_ORIGIN = "progressive-reading-setup://local";
export const URL_COOKIE_SYNC_ALLOWED_HOSTNAMES = Object.freeze([
  "www.zhihu.com",
  "zhihu.com",
  "x.com",
  "twitter.com"
]);

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 10;
const DEFAULT_TIMEOUT_MS = 45_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function isLoopbackAddress(value) {
  const address = String(value || "").toLowerCase();
  return address === "::1" || address === "127.0.0.1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

export function validateCookieSyncSetupOrigin(value) {
  const origin = String(value || "").trim();
  if (!origin || origin.includes(",")) throw new Error("cookie_sync_origin_required");
  if (origin !== URL_COOKIE_SETUP_ORIGIN) throw new Error("cookie_sync_origin_not_allowed");
  return URL_COOKIE_SETUP_ORIGIN;
}

export function validateCookieSyncContentType(value) {
  const contentType = String(value || "").trim();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new Error("cookie_sync_content_type_must_be_application_json");
  }
  return contentType;
}

function validateCookieHeader(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("cookie_sync_cookie_header_required");
  if (Buffer.byteLength(value, "utf8") > 8192 || /[\r\n\0]/u.test(value)) throw new Error("cookie_sync_cookie_header_invalid_size_or_control");
  const pairs = value.split(";");
  if (!pairs.length || pairs.length > 128 || pairs.some((pair) => !pair.trim())) throw new Error("cookie_sync_cookie_header_invalid_pair_count");
  const names = new Set();
  const normalized = [];
  for (const rawPair of pairs) {
    const pair = rawPair.trim();
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new Error("cookie_sync_cookie_header_invalid_pair");
    const name = pair.slice(0, separator).trim();
    const rawCookieValue = pair.slice(separator + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name)) throw new Error("cookie_sync_cookie_name_invalid");
    const unquoted = rawCookieValue.startsWith('"') && rawCookieValue.endsWith('"')
      ? rawCookieValue.slice(1, -1)
      : rawCookieValue;
    if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/u.test(unquoted)) throw new Error("cookie_sync_cookie_value_invalid");
    if (names.has(name)) throw new Error("cookie_sync_duplicate_cookie_name");
    names.add(name);
    normalized.push(`${name}=${rawCookieValue}`);
  }
  return { header: normalized.join("; "), count: normalized.length };
}

export function validateCookieSyncPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("cookie_sync_payload_object_required");
  const rootKeys = Object.keys(payload);
  if (rootKeys.some((key) => !new Set(["schema", "cookies"]).has(key))) throw new Error("cookie_sync_payload_unknown_field");
  if (payload.schema !== URL_COOKIE_SYNC_SCHEMA) throw new Error("cookie_sync_schema_invalid");
  if (!payload.cookies || typeof payload.cookies !== "object" || Array.isArray(payload.cookies)) throw new Error("cookie_sync_cookies_object_required");
  const entries = Object.entries(payload.cookies);
  if (!entries.length || entries.length > URL_COOKIE_SYNC_ALLOWED_HOSTNAMES.length) throw new Error("cookie_sync_domain_count_invalid");
  const allowed = new Set(URL_COOKIE_SYNC_ALLOWED_HOSTNAMES);
  const cookies = new Map();
  const domains = [];
  let totalBytes = 0;
  for (const [hostname, rawHeader] of entries) {
    if (!allowed.has(hostname)) throw new Error("cookie_sync_hostname_not_allowed");
    const validated = validateCookieHeader(rawHeader);
    totalBytes += Buffer.byteLength(validated.header, "utf8");
    if (totalBytes > 32768) throw new Error("cookie_sync_total_cookie_bytes_exceeded");
    cookies.set(hostname, validated.header);
    domains.push({
      hostname,
      cookie_count: validated.count,
      fingerprint: `sha256:${sha256(`${hostname}\n${validated.header}`)}`
    });
  }
  return { cookies, domains: domains.sort((left, right) => left.hostname.localeCompare(right.hostname)) };
}

export function mergeCookieSyncIntoProcessEnvironment(currentCookies, incomingCookies, env = process.env) {
  const merged = new Map(currentCookies || []);
  for (const [hostname, cookie] of incomingCookies || []) merged.set(hostname, cookie);
  const cookies = Object.fromEntries([...merged.entries()].sort(([left], [right]) => left.localeCompare(right)));
  env[URL_COOKIE_ENV] = JSON.stringify({ schema: URL_COOKIE_SCHEMA, cookies });
  return loadDomainCookieMap(env);
}

export function withoutUrlCookieEnvironment(env = process.env) {
  const sanitized = { ...env };
  delete sanitized[URL_COOKIE_ENV];
  return sanitized;
}

function normalizedCookieHostname(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw.includes("*") || raw.startsWith(".") || /[\s/:?#@]/u.test(raw)) return null;
  try {
    const hostname = new URL(`https://${raw}/`).hostname.toLowerCase();
    return hostname === raw ? hostname : null;
  } catch {
    return null;
  }
}

export function loadDomainCookieMap(env = process.env) {
  const raw = String(env?.[URL_COOKIE_ENV] || "").trim();
  if (!raw) {
    return {
      cookies: new Map(),
      health: { schema: URL_COOKIE_SCHEMA, configured: false, domain_count: 0, domain_fingerprints: [], values_exposed: false }
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("url_cookie_map_invalid_json");
  }
  if (parsed?.schema !== URL_COOKIE_SCHEMA) throw new Error("url_cookie_map_invalid_schema");
  if (!parsed.cookies || typeof parsed.cookies !== "object" || Array.isArray(parsed.cookies)) {
    throw new Error("url_cookie_map_cookies_object_required");
  }
  const entries = Object.entries(parsed.cookies);
  if (!entries.length) throw new Error("url_cookie_map_empty");
  if (entries.length > 100) throw new Error("url_cookie_map_too_many_domains");
  const cookies = new Map();
  for (const [domain, cookie] of entries) {
    const hostname = normalizedCookieHostname(domain);
    if (!hostname) throw new Error("url_cookie_map_invalid_exact_hostname");
    if (typeof cookie !== "string" || !cookie.trim()) throw new Error("url_cookie_map_cookie_value_required");
    if (cookie.length > 8192 || /[\r\n]/u.test(cookie)) throw new Error("url_cookie_map_cookie_value_invalid");
    if (cookies.has(hostname)) throw new Error("url_cookie_map_duplicate_hostname");
    cookies.set(hostname, cookie);
  }
  return {
    cookies,
    health: {
      schema: URL_COOKIE_SCHEMA,
      configured: true,
      domain_count: cookies.size,
      domain_fingerprints: [...cookies.keys()].sort().map((hostname) => sha256(hostname).slice(0, 12)),
      values_exposed: false
    }
  };
}

export function normalizeBackgroundFetchUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export class UrlImportDegradedError extends Error {
  constructor(status, reason, details = {}) {
    super(reason);
    this.name = "UrlImportDegradedError";
    this.status = status;
    this.details = details;
  }
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function authPageReason(document, finalUrl) {
  const pathname = new URL(finalUrl).pathname;
  if (/\/(?:login|log-in|signin|sign-in|auth|passport)(?:\/|$)/iu.test(pathname)) return "redirected_to_login_page";
  if (document.querySelector('input[type="password"]')) return "password_form_detected";
  const loginForm = [...document.querySelectorAll("form")].some((form) => {
    const action = String(form.getAttribute("action") || "");
    return /(?:login|signin|auth|passport)/iu.test(action);
  });
  if (loginForm) return "login_form_detected";
  const text = normalizedText(document.body?.textContent).slice(0, 12_000);
  return /(?:请先登录|登录后(?:查看|继续|阅读)|需要登录|sign in to (?:continue|read|view)|log in to (?:continue|read|view))/iu.test(text)
    ? "login_required_message_detected"
    : null;
}

function jsRenderReason(document, visibleText, { scriptCount, noscript }) {
  if (scriptCount === 0 || visibleText.length >= 120) return null;
  const shell = document.querySelector("#app:empty, #root:empty, #__next:empty, #__nuxt:empty, [data-reactroot]:empty");
  const pageText = normalizedText(document.body?.textContent);
  if (shell) return "empty_javascript_application_shell";
  if (/(?:enable|requires?) javascript|javascript (?:is )?required|请启用\s*javascript/iu.test(`${noscript} ${pageText}`)) {
    return "javascript_required_message_detected";
  }
  return visibleText.length < 40 && scriptCount >= 2 ? "script_only_page_shell" : null;
}

function htmlDetails(html, finalUrl) {
  const dom = new JSDOM(html, { url: finalUrl });
  const document = dom.window.document;
  const scriptCount = document.querySelectorAll("script").length;
  const noscript = normalizedText([...document.querySelectorAll("noscript")].map((node) => node.textContent).join(" "));
  const authReason = authPageReason(document, finalUrl);
  document.querySelectorAll("script, style, template, noscript").forEach((node) => node.remove());
  const visibleText = normalizedText(document.body?.textContent);
  const title = normalizedText(document.title);
  const jsReason = jsRenderReason(document, visibleText, { scriptCount, noscript });
  dom.window.close();
  return { title, visibleText, authReason, jsReason };
}

async function readBody(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("url_fetch_content_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function contentKind(contentType) {
  const plain = /text\/(?:plain|markdown)|application\/(?:markdown|json)/iu.test(contentType);
  const html = /text\/html|application\/xhtml\+xml|application\/xml|text\/xml/iu.test(contentType) || !contentType;
  return { plain, html };
}

function fetchHeaders(cookie) {
  const headers = {
    "User-Agent": "ProgressiveReading-LocalFetcher/1.0",
    "Accept": "text/html,application/xhtml+xml,application/xml,text/markdown,text/plain;q=0.9,*/*;q=0.8"
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function bodyReflectsCookieSecret(body, cookie) {
  if (!cookie) return false;
  const candidates = new Set([cookie]);
  for (const pair of cookie.split(";")) {
    const value = pair.slice(pair.indexOf("=") + 1).trim();
    if (value.length >= 8) candidates.add(value);
  }
  return [...candidates].some((secret) => secret && body.includes(secret));
}

function htmlEscape(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function fetchZhihuCreationProjectFallback(finalUrl, {
  fetchImpl,
  cookieHeaderForUrl,
  cookieByHostname,
  signal,
  maxBytes
}) {
  const parsed = new URL(finalUrl);
  const match = parsed.hostname === "www.zhihu.com" ? parsed.pathname.match(/^\/project\/detail\/(\d+)$/u) : null;
  if (!match) return null;
  const projectId = match[1];
  const apiUrl = `https://www.zhihu.com/api/v4/creation_project/projects/${projectId}/detail`;
  const cookie = typeof cookieHeaderForUrl === "function"
    ? cookieHeaderForUrl(apiUrl)
    : cookieByHostname.get("www.zhihu.com") || cookieByHostname.get("zhihu.com") || null;
  const response = await fetchImpl(apiUrl, {
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    headers: { ...fetchHeaders(cookie), Accept: "application/json, text/plain, */*" },
    signal
  });
  if (new Set([401, 403, 407]).has(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    throw new UrlImportDegradedError(REQUIRES_BROWSER_AUTH, `zhihu_project_api_http_${response.status}`, {
      final_url: finalUrl,
      project_id: projectId
    });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`zhihu_project_api_http_${response.status}`);
  }
  const bytes = await readBody(response, maxBytes);
  const json = new TextDecoder("utf-8").decode(bytes);
  if (bodyReflectsCookieSecret(json, cookie)) throw new Error("url_fetch_cookie_secret_reflection_detected");
  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error("zhihu_project_api_json_invalid");
  }
  const content = payload?.status === 0 ? payload?.data?.content : null;
  const title = String(content?.title || payload?.data?.project_info?.name || "").trim();
  const detailHtml = String(content?.body || "").trim();
  if (!title || !detailHtml) throw new Error("zhihu_project_api_content_missing");
  const description = String(content?.description || "").trim();
  const links = [
    content?.work_url ? `<p>项目链接：<a href="${htmlEscape(content.work_url)}">${htmlEscape(content.work_url)}</a></p>` : "",
    content?.github_url ? `<p>GitHub：<a href="${htmlEscape(content.github_url)}">${htmlEscape(content.github_url)}</a></p>` : ""
  ].filter(Boolean).join("\n");
  return {
    body: `<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(title)}</title></head><body><article><h1>${htmlEscape(title)}</h1>${description ? `<p>${htmlEscape(description)}</p>` : ""}${links}${detailHtml}</article></body></html>`,
    projectId,
    apiResponseStatus: response.status,
    authenticated: Boolean(cookie)
  };
}

export async function fetchUrlWithoutBrowser(requestedUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  maxBytes = DEFAULT_MAX_BYTES,
  cookieByHostname = new Map(),
  cookieHeaderForUrl = null
} = {}) {
  const normalizedUrl = normalizeBackgroundFetchUrl(requestedUrl);
  if (!normalizedUrl) throw new Error("invalid_url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("url_fetch_timeout")), timeoutMs);
  const redirectChain = [];
  let currentUrl = normalizedUrl;
  let response;
  let authenticatedFetch = false;
  let responseCookie = null;
  try {
    for (let index = 0; index <= maxRedirects; index += 1) {
      const currentHostname = new URL(currentUrl).hostname.toLowerCase();
      const cookie = typeof cookieHeaderForUrl === "function"
        ? cookieHeaderForUrl(currentUrl)
        : cookieByHostname.get(currentHostname) || null;
      responseCookie = cookie;
      authenticatedFetch ||= Boolean(cookie);
      response = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: fetchHeaders(cookie),
        signal: controller.signal
      });
      if (!REDIRECT_STATUSES.has(response.status)) break;
      const location = response.headers.get("location");
      if (!location) throw new Error(`url_fetch_redirect_missing_location:${response.status}`);
      const nextUrl = normalizeBackgroundFetchUrl(new URL(location, currentUrl).toString());
      if (!nextUrl) throw new Error("url_fetch_redirect_invalid_url");
      redirectChain.push({ status: response.status, from_url: currentUrl, to_url: nextUrl });
      await response.body?.cancel().catch(() => undefined);
      if (redirectChain.length > maxRedirects) throw new Error("url_fetch_too_many_redirects");
      currentUrl = nextUrl;
    }
    if (!response) throw new Error("url_fetch_no_response");
    if (REDIRECT_STATUSES.has(response.status)) throw new Error("url_fetch_too_many_redirects");
    const fetchBase = {
      requested_url: normalizedUrl,
      final_url: currentUrl,
      redirect_chain: redirectChain,
      response_status: response.status
    };
    if (new Set([401, 403, 407]).has(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      throw new UrlImportDegradedError(REQUIRES_BROWSER_AUTH, `http_${response.status}_authentication_or_access_required`, fetchBase);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`url_fetch_http_${response.status}`);
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > maxBytes) throw new Error("url_fetch_content_too_large");
    let bytes = await readBody(response, maxBytes);
    if (!bytes.byteLength) throw new Error("url_fetch_empty_body");
    let contentType = String(response.headers.get("content-type") || "").toLowerCase();
    let charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/iu)?.[1] || "utf-8";
    let body;
    try {
      body = new TextDecoder(charset).decode(bytes);
    } catch {
      body = new TextDecoder("utf-8").decode(bytes);
    }
    if (!body.trim()) throw new Error("url_fetch_empty_body");
    if (bodyReflectsCookieSecret(body, responseCookie)) throw new Error("url_fetch_cookie_secret_reflection_detected");
    const zhihuProjectFallback = await fetchZhihuCreationProjectFallback(currentUrl, {
      fetchImpl,
      cookieHeaderForUrl,
      cookieByHostname,
      signal: controller.signal,
      maxBytes
    });
    if (zhihuProjectFallback) {
      body = zhihuProjectFallback.body;
      bytes = new TextEncoder().encode(body);
      contentType = "text/html; charset=utf-8";
      charset = "utf-8";
      authenticatedFetch ||= zhihuProjectFallback.authenticated;
    }
    const { plain, html } = contentKind(contentType);
    if (!plain && !html) throw new Error(`url_fetch_unsupported_content_type:${contentType || "unknown"}`);
    const encoding = String(response.headers.get("content-encoding") || "").toLowerCase();
    const integrity = {
      response_body_sha256: sha256(bytes),
      received_body_bytes: bytes.byteLength,
      declared_content_length: declaredLength || null,
      content_encoding: encoding || null,
      length_matches_declared: declaredLength && !encoding ? declaredLength === bytes.byteLength : null,
      truncated: false,
      complete: !declaredLength || Boolean(encoding) || declaredLength === bytes.byteLength
    };
    if (!integrity.complete) throw new Error("url_fetch_content_length_mismatch");

    let title = "";
    let visibleText = plain ? normalizedText(body) : "";
    if (html) {
      const details = htmlDetails(body, currentUrl);
      title = details.title;
      visibleText = details.visibleText;
      const degradedDetails = { ...fetchBase, content_type: contentType || "unknown", content_integrity: integrity };
      if (details.authReason) throw new UrlImportDegradedError(REQUIRES_BROWSER_AUTH, details.authReason, degradedDetails);
      if (details.jsReason) throw new UrlImportDegradedError(REQUIRES_JS_RENDER, details.jsReason, degradedDetails);
    }

    return {
      requestedUrl: normalizedUrl,
      finalUrl: currentUrl,
      redirectChain,
      body,
      isHtml: html,
      isPlainText: plain,
      title,
      visibleText,
      sourceMetadata: {
        source_url: normalizedUrl,
        canonical_url: currentUrl,
        redirect_chain: redirectChain,
        redirected: redirectChain.length > 0,
        response_status: response.status,
        content_type: contentType || "unknown",
        charset,
        content_integrity: {
          ...integrity,
          visible_text_chars: visibleText.length
        },
        capture_agent: "local_background_url_fetch",
        fetch_transport: BACKGROUND_FETCH_TRANSPORT,
        ...(zhihuProjectFallback ? {
          capture_fallback: "zhihu_creation_project_api",
          project_id: zhihuProjectFallback.projectId,
          project_api_response_status: zhihuProjectFallback.apiResponseStatus
        } : {})
      },
      fetchReceipt: {
        fetched_at: new Date().toISOString(),
        cookie_policy: "versioned_snapshot_cookie_matching_no_store",
        authenticated_fetch: authenticatedFetch,
        browser_tab_created: false
      }
    };
  } catch (error) {
    if (error?.name === "AbortError" || controller.signal.aborted) throw new Error("url_fetch_timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
