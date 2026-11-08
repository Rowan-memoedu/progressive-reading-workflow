// User-supplied URL only. Runs the real rule in isolated storage with the real
// producer configuration; no synthetic fetch or synthetic preprocessing is used.
// --service=http://127.0.0.1:37829 uses the activated service and its live Chrome
// authentication in the formal reading area, without copying credentials.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { startFixture } from "./browser-import-web/fixture.mjs";
import { zhihuColumnIdentity } from "./import-rule-catalog.mjs";
import { resultView } from "./browser-import-web/client.mjs";

const url = process.argv[2];
if (!zhihuColumnIdentity(url)) throw new Error("Pass a user-authorized Zhihu column URL.");
const serviceOption = process.argv.slice(3).find(value => value.startsWith("--service="))?.slice(10);
let fixture;
if (serviceOption) {
  const service = new URL(serviceOption);
  if (service.protocol !== "http:" || service.hostname !== "127.0.0.1" || service.pathname !== "/" || service.username || service.password || service.search || service.hash) throw new Error("canary_loopback_service_required");
  const base = "D:/Artifacts/ProgressiveReading/web-import";
  await fs.mkdir(base, { recursive: true });
  fixture = { baseUrl: service.origin, root: await fs.mkdtemp(path.join(base, "live-column-")), stop: async () => {} };
} else fixture = await startFixture({ producer: "" });
const evidence = { source_url: url, rule_id: "zhihu-column-all-articles", storage: serviceOption ? "formal_service" : "isolated", synthetic_fetch: false, synthetic_producer: false, root: fixture.root };
try {
  if (serviceOption) {
    const response = await fetch(`${fixture.baseUrl}/api/browser-import/cookies/status`);
    if (!response.ok) throw new Error("live_cookie_receiver_not_activated");
    const auth = await response.json();
    evidence.authentication = auth;
    if (!auth.loaded || !auth.cookie_count) throw new Error("chrome_login_sync_required_before_canary");
  }
  const createdResponse = await fetch(`${fixture.baseUrl}/api/browser-import/requests`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: [url], source: "web_import_page", entry_route: "obsidian", client_request_id: `user-column-canary-${crypto.randomUUID()}` }) });
  if (createdResponse.status !== 202) throw new Error(`http_${createdResponse.status}`);
  const created = await createdResponse.json();
  evidence.request_id = created.request_id;
  evidence.status = "running";
  await fs.writeFile(path.join(fixture.root, "real-column-canary.json"), JSON.stringify(evidence, null, 2));
  const deadline = Date.now() + 60 * 60 * 1000;
  let summary;
  let lastPhase = "";
  do {
    summary = await (await fetch(`${fixture.baseUrl}/api/browser-import/requests/${created.request_id}`)).json();
    const articles = summary.results[0]?.collection?.results || [];
    const finished = articles.filter(item => ["imported", "imported_with_warnings", "idempotent_replay", "failed", "requires_browser_auth"].includes(item.status)).length;
    const phase = `${summary.status}:${summary.results[0]?.collection?.phase}:${finished}/${articles.length}`;
    if (phase !== lastPhase) { console.log(phase); lastPhase = phase; }
    if (summary.terminal) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  evidence.result = summary;
  const item = summary.results[0];
  evidence.status = summary.terminal && ["success", "warning"].includes(resultView(item).kind) ? "passed" : "blocked";
  evidence.files = [];
  for (const artifact of (item.artifacts || []).filter(artifact => artifact.kind === "markdown")) {
    const body = await fs.readFile(artifact.path);
    const hash = createHash("sha256").update(body).digest("hex");
    if (hash !== artifact.sha256 || !body.length) throw new Error("formal_file_readback_failed");
    evidence.files.push({ path: artifact.path, sha256: hash, bytes: body.length });
  }
  console.log(JSON.stringify({ status: evidence.status, result: summary.status, error: item.error, files: evidence.files.length, receipt: path.join(fixture.root, "real-column-canary.json") }));
  if (evidence.status !== "passed") process.exitCode = 2;
} catch (error) { evidence.status = "failed"; evidence.error = error.message; throw error; }
finally { await fs.writeFile(path.join(fixture.root, "real-column-canary.json"), JSON.stringify(evidence, null, 2)); await fixture.stop(); }
