#!/usr/bin/env node

import {
  URL_COOKIE_ENV,
  URL_COOKIE_SETUP_ORIGIN,
  URL_COOKIE_SYNC_ALLOWED_HOSTNAMES,
  URL_COOKIE_SYNC_SCHEMA,
  loadDomainCookieMap
} from "./url-background-fetch.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT_SCAN_START = 37829;
const PORT_SCAN_END = 37849;
const HEALTH_PATH = "/api/highlights/health";
const REQUEST_TIMEOUT_MS = 5_000;

function usage() {
  return [
    "Usage: npm run url-cookie:setup -- [--port <37829-37849>] [--json]",
    "",
    `Input is accepted only from the current process environment variable ${URL_COOKIE_ENV}.`,
    "Cookie values are never accepted as command-line arguments and are never written by this tool."
  ].join("\n");
}

function parseArgs(argv) {
  const options = { port: null, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") options.json = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else if (value === "--port") {
      const port = Number(argv[index + 1]);
      if (!Number.isInteger(port) || port < PORT_SCAN_START || port > PORT_SCAN_END) throw new Error("url_cookie_setup_port_invalid");
      options.port = port;
      index += 1;
    } else {
      throw new Error("url_cookie_setup_argument_invalid");
    }
  }
  return options;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probePort(port) {
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}${HEALTH_PATH}`);
    if (!response.ok) return null;
    const health = await response.json();
    if (health?.status !== "ok" || health?.service !== "local-ir-browser-highlight") return null;
    if (health?.cookieSync?.legacySchema !== URL_COOKIE_SYNC_SCHEMA
      || health?.cookieSync?.legacySetupOrigin !== URL_COOKIE_SETUP_ORIGIN) return null;
    return { port, health };
  } catch {
    return null;
  }
}

async function discoverService(preferredPort) {
  const ports = preferredPort === null
    ? Array.from({ length: PORT_SCAN_END - PORT_SCAN_START + 1 }, (_, index) => PORT_SCAN_START + index)
    : [preferredPort];
  for (const port of ports) {
    const result = await probePort(port);
    if (result) return result;
  }
  throw new Error(preferredPort === null ? "url_cookie_setup_service_unavailable" : "url_cookie_setup_service_contract_mismatch");
}

function setupPayloadFromEnvironment(env = process.env) {
  const loaded = loadDomainCookieMap(env);
  if (!loaded.health.configured) throw new Error("url_cookie_setup_env_required");
  const allowed = new Set(URL_COOKIE_SYNC_ALLOWED_HOSTNAMES);
  if ([...loaded.cookies.keys()].some((hostname) => !allowed.has(hostname))) throw new Error("url_cookie_setup_hostname_not_allowed");
  return {
    schema: URL_COOKIE_SYNC_SCHEMA,
    cookies: Object.fromEntries(loaded.cookies)
  };
}

function publicResult(port, response) {
  if (response?.status !== "synchronized"
    || !Number.isInteger(response.cookie_count)
    || response.cookie_count < 1
    || !Number.isInteger(response.domain_count)
    || response.domain_count < 1
    || !/^sha256:[a-f0-9]{64}$/u.test(String(response.fingerprint || ""))) {
    throw new Error("url_cookie_setup_response_contract_invalid");
  }
  return {
    status: "synchronized",
    port,
    cookie_count: response.cookie_count,
    domain_count: response.domain_count,
    skipped_count: Number(response.skipped_count || 0),
    fingerprint: response.fingerprint,
    persistence: {
      scope: "current_service_process",
      resync_required_after_restart: true
    },
    cookie_values_exposed: false
  };
}

async function synchronize(port, payload) {
  const response = await fetchWithTimeout(`http://127.0.0.1:${port}/api/browser-import/cookies/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: URL_COOKIE_SETUP_ORIGIN
    },
    body: JSON.stringify(payload)
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    throw new Error("url_cookie_setup_response_not_json");
  }
  if (!response.ok) throw new Error(String(data?.error || `url_cookie_setup_http_${response.status}`));
  return publicResult(port, data);
}

export async function runUrlCookieSetup({ argv = process.argv.slice(2), env = process.env } = {}) {
  const options = parseArgs(argv);
  if (options.help) return { help: usage() };
  let payload;
  try {
    payload = setupPayloadFromEnvironment(env);
  } finally {
    delete env[URL_COOKIE_ENV];
  }
  const service = await discoverService(options.port);
  return synchronize(service.port, payload);
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  runUrlCookieSetup().then((result) => {
    if (result.help) process.stdout.write(`${result.help}\n`);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${String(error?.message || "url_cookie_setup_failed")}\n`);
    process.exitCode = 1;
  });
}
