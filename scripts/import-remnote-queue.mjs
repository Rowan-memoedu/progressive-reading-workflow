#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import path from "node:path";
import { applyQueue, buildDryRunPlan, ENGINE_VERSION, rollbackLocalReceipt } from "../remnote-formal-archive/core.mjs";

const DEFAULT_QUEUE_DIR = "RemNote 导出队列";
const DEFAULT_MCP_URL = "http://127.0.0.1:43101/mcp";

const args = parseArgs(process.argv.slice(2));
const workflowRoot = process.cwd();
const queueDir = path.resolve(workflowRoot, args.queue || DEFAULT_QUEUE_DIR);
const stateDir = path.resolve(workflowRoot, args.stateDir || "remnote-formal-archive/runtime");
const receiptsDir = path.resolve(workflowRoot, args.receiptsDir || "remnote-formal-archive/receipts");
const vaultRoot = path.resolve(workflowRoot, args.vaultRoot || "../..");
const mcpUrl = args.mcpUrl || process.env.REMNOTE_MCP_URL || DEFAULT_MCP_URL;
const target = { parentRemId: args.parentRemId, parentTitle: args.parentTitle };

async function main() {
  if (args.help) {
    printHelp();
    return;
  }
  if (args.version) {
    console.log(ENGINE_VERSION);
    return;
  }
  if (args.rollbackReceipt) {
    const rollbackPath = await rollbackLocalReceipt({ receiptPath: path.resolve(workflowRoot, args.rollbackReceipt), stateDir, vaultRoot });
    console.log(args.json ? JSON.stringify({ ok: true, rollbackPath }, null, 2) : `本地回滚完成：${rollbackPath}\nRemNote 节点已保留，未执行删除。`);
    return;
  }
  if (args.dryRun) {
    const plan = await buildDryRunPlan({ queueDir, stateDir, target });
    console.log(args.json ? JSON.stringify(plan, null, 2) : renderHumanPlan(plan));
    if (plan.invalid.length > 0 || plan.packages.some((item) => item.action.startsWith("reject_"))) process.exitCode = 2;
    return;
  }

  const client = new RemNoteMcpClient(mcpUrl);
  try {
    const result = await applyQueue({ queueDir, stateDir, receiptsDir, vaultRoot, target, client });
    console.log(args.json ? JSON.stringify(result, null, 2) : renderHumanResult(result));
    if (!result.ok) process.exitCode = 2;
  } finally {
    await client.close();
  }
}

function renderHumanPlan(plan) {
  const lines = [
    `Formal Archive dry-run v${ENGINE_VERSION}`,
    `planHash: ${plan.planHash}`,
    `包: ${plan.summary.packageCount} / 条目: ${plan.summary.itemCount} / 无效: ${plan.summary.invalidCount}`,
    `目标: ${plan.target.parentTitle || "<apply 时必填>"} (${plan.target.parentRemId || "<apply 时必填>"})`
  ];
  for (const item of plan.packages) lines.push(`- ${item.action} | ${item.packageId} | ${item.file} | ${item.items.length} items`);
  for (const item of plan.invalid) lines.push(`- invalid | ${item.file} | ${item.errors.join("; ")}`);
  return lines.join("\n");
}

function renderHumanResult(result) {
  const lines = [`Formal Archive apply: ${result.ok ? "OK" : "FAILED"}`, `target: ${result.target.title} (${result.target.remId})`];
  for (const item of result.results) lines.push(`- ${item.status} | ${item.packageId}${item.receiptPath ? ` | ${item.receiptPath}` : ""}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    json: false,
    help: false,
    version: false,
    queue: "",
    stateDir: "",
    receiptsDir: "",
    vaultRoot: "",
    mcpUrl: "",
    parentRemId: "",
    parentTitle: "",
    rollbackReceipt: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--version") parsed.version = true;
    else if (arg === "--queue") parsed.queue = requiredValue(argv, ++index, arg);
    else if (arg === "--state-dir") parsed.stateDir = requiredValue(argv, ++index, arg);
    else if (arg === "--receipts-dir") parsed.receiptsDir = requiredValue(argv, ++index, arg);
    else if (arg === "--vault-root") parsed.vaultRoot = requiredValue(argv, ++index, arg);
    else if (arg === "--mcp-url") parsed.mcpUrl = requiredValue(argv, ++index, arg);
    else if (arg === "--parent-rem-id") parsed.parentRemId = requiredValue(argv, ++index, arg);
    else if (arg === "--parent-title") parsed.parentTitle = requiredValue(argv, ++index, arg);
    else if (arg === "--rollback-receipt") parsed.rollbackReceipt = requiredValue(argv, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`RemNote formal archive importer v${ENGINE_VERSION}

Dry-run (zero writes):
  node scripts/import-remnote-queue.mjs --dry-run --json

Apply (exact target required):
  node scripts/import-remnote-queue.mjs --parent-rem-id <RemID> --parent-title <exact title> --json

Local rollback (does not delete RemNote nodes):
  node scripts/import-remnote-queue.mjs --rollback-receipt <receipt.json> --json

Options:
  --queue <dir> --state-dir <dir> --receipts-dir <dir> --vault-root <dir>
  --mcp-url <url> --dry-run --json --version --help`);
}

export class RemNoteMcpClient {
  constructor(url) {
    this.url = url;
    this.client = null;
    this.transport = null;
  }

  async call(name, payload) {
    await this.connect();
    const result = await this.client.callTool({ name, arguments: payload });
    if (result.isError) throw new Error(extractText(result));
    return parseToolResult(result);
  }

  async connect() {
    if (this.client) return;
    this.transport = new StreamableHTTPClientTransport(new URL(this.url));
    this.client = new Client({ name: "progressive-reading-remnote-formal-archive", version: ENGINE_VERSION });
    await this.client.connect(this.transport);
  }

  async close() {
    try { if (this.transport) await this.transport.terminateSession(); } catch {}
    try { if (this.client) await this.client.close(); } catch {}
  }
}

function parseToolResult(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = extractText(result);
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

function extractText(result) {
  const item = result.content?.find((entry) => entry.type === "text" && entry.text);
  return item?.text || JSON.stringify(result);
}

main().catch((error) => {
  if (args.json) {
    console.error(JSON.stringify({ ok: false, code: error?.code || "UNEXPECTED_ERROR", message: error instanceof Error ? error.message : String(error) }, null, 2));
  } else {
    console.error(`[${error?.code || "UNEXPECTED_ERROR"}] ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
});
