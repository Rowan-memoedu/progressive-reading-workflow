const PORT_SCAN_START = 37829;
const PORT_SCAN_END = 37849;
const HEALTH_TIMEOUT_MS = 900;
const SYNC_TIMEOUT_MS = 30_000;
const MAX_SYNC_BYTES = 33_554_432;
const MAX_SYNC_COOKIES = 50_000;
const SYNC_SCHEMA = "local-ir.chrome-cookie-jar-sync/v1";
const SYNC_ENDPOINT = "/api/browser-import/cookies/sync";

function timeoutController(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

async function requestJson(port, path, options = {}, timeoutMs = HEALTH_TIMEOUT_MS) {
  const timeout = timeoutController(timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...options,
      signal: timeout.signal
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("local_service_invalid_response");
    }
    if (!response.ok) throw new Error(`local_service_http_${response.status}`);
    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("local_service_timeout");
    throw new Error(String(error?.message || "local_service_request_failed"));
  } finally {
    timeout.close();
  }
}

function validHealthContract(health) {
  const contract = health?.cookieSync;
  return health?.status === "ok"
    && health?.service === "local-ir-browser-highlight"
    && contract?.endpoint === SYNC_ENDPOINT
    && contract?.schema === SYNC_SCHEMA
    && contract?.maxCookies === MAX_SYNC_COOKIES
    && contract?.maxBodyBytes === MAX_SYNC_BYTES
    && contract?.atomicReplace === true;
}

async function findServicePort() {
  for (let port = PORT_SCAN_START; port <= PORT_SCAN_END; port += 1) {
    try {
      const health = await requestJson(port, "/api/highlights/health");
      if (validHealthContract(health)) return port;
    } catch {
      // Continue through the bounded loopback range.
    }
  }
  throw new Error("local_service_unavailable");
}

function readAllCookies() {
  return new Promise((resolve, reject) => {
    chrome.cookies.getAll({}, (cookies) => {
      if (chrome.runtime.lastError) {
        reject(new Error("chrome_cookie_read_failed"));
        return;
      }
      resolve(Array.isArray(cookies) ? cookies : []);
    });
  });
}

function contractCookie(cookie) {
  return {
    name: String(cookie?.name ?? ""),
    value: String(cookie?.value ?? ""),
    domain: String(cookie?.domain ?? ""),
    hostOnly: cookie?.hostOnly === true,
    path: String(cookie?.path ?? "/"),
    secure: cookie?.secure === true,
    httpOnly: cookie?.httpOnly === true,
    sameSite: String(cookie?.sameSite || "unspecified"),
    session: cookie?.session === true,
    expirationDate: cookie?.session === true ? null : Number(cookie?.expirationDate),
    storeId: String(cookie?.storeId ?? ""),
    partitionKey: cookie?.partitionKey ?? null
  };
}

function validateSafeReceipt(data) {
  const cookieCount = Number(data?.cookie_count);
  const domainCount = Number(data?.domain_count);
  const skippedCount = Number(data?.skipped_count);
  const validCounts = [cookieCount, domainCount, skippedCount]
    .every((value) => Number.isInteger(value) && value >= 0);
  if (data?.status !== "synchronized"
    || data?.schema !== SYNC_SCHEMA
    || data?.cookie_values_exposed !== false
    || !validCounts) throw new Error("cookie_sync_response_contract_invalid");
  return {
    totalCount: cookieCount + skippedCount,
    domainCount,
    skippedCount
  };
}

async function synchronizeAllCookies() {
  let sourceCookies;
  try {
    sourceCookies = await readAllCookies();
  } catch {
    throw new Error("chrome_cookie_read_failed");
  }
  if (sourceCookies.length > MAX_SYNC_COOKIES) throw new Error("cookie_sync_payload_too_large");

  const body = JSON.stringify({
    schema: SYNC_SCHEMA,
    cookies: sourceCookies.map(contractCookie)
  });
  if (new TextEncoder().encode(body).byteLength > MAX_SYNC_BYTES) {
    throw new Error("cookie_sync_payload_too_large");
  }

  let port;
  try {
    port = await findServicePort();
  } catch {
    throw new Error("local_service_unavailable");
  }

  try {
    const data = await requestJson(port, SYNC_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    }, SYNC_TIMEOUT_MS);
    return validateSafeReceipt(data);
  } catch {
    throw new Error("cookie_sync_failed");
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "sync-all-chrome-cookies") return false;
  synchronizeAllCookies().then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: String(error?.message || "cookie_sync_failed") })
  );
  return true;
});
