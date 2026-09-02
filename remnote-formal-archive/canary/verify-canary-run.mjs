#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runId = readArg("--run-id") || "v0.2.0-20260822-a";
const runRoot = path.join(here, "runs", runId);
const manifest = await readJson(path.join(runRoot, "canary-manifest.json"));
const result = await readJson(path.join(runRoot, "canary-result.json"));
const checks = [];

for (const group of manifest.groups) {
  const state = await readJson(path.join(group.stateDir, "state.v1.json"));
  const receiptFiles = (await readdir(group.receiptsDir)).filter((name) => name.endsWith(".json") && !name.includes("--failed"));
  const receipts = await Promise.all(receiptFiles.map((name) => readJson(path.join(group.receiptsDir, name))));
  const expectedIds = new Set(group.scenarios.map((scenario) => scenario.packageId));
  assert(receipts.length === expectedIds.size, `${group.id}: success receipt count mismatch`);
  for (const scenario of group.scenarios) {
    const packageState = state.packages[scenario.packageId];
    assert(packageState?.status === "archived", `${scenario.packageId}: state is not archived`);
    assert(!Object.hasOwn(packageState, "lastError") && !Object.hasOwn(packageState, "failedAt"), `${scenario.packageId}: stale failure fields`);
    const receipt = receipts.find((entry) => entry.packageId === scenario.packageId);
    assert(receipt?.schema === "progressive-reading.remnote-archive-receipt/v2", `${scenario.packageId}: receipt schema mismatch`);
    assert(receipt?.status === "archived", `${scenario.packageId}: receipt status mismatch`);
    assert(receipt?.readback?.verified === true, `${scenario.packageId}: readback not verified`);
    assert(receipt?.dispositionCoverage?.verified === true, `${scenario.packageId}: disposition coverage not verified`);
    assert(receipt?.readback?.items?.every((item) => item.verified === true), `${scenario.packageId}: item readback mismatch`);
    const packageRaw = await readJson(scenario.packageFile);
    assert(packageRaw.formalArchive?.status === "archived", `${scenario.packageId}: package marker missing`);
    assert(packageRaw.importStatus === "imported_and_verified", `${scenario.packageId}: package importStatus mismatch`);
    const sourceFile = path.basename(packageRaw.localArchive.sourcePath);
    assert(!(await exists(path.join(group.vaultRoot, "staging", sourceFile))), `${scenario.packageId}: source remains in staging`);
    assert(await exists(path.join(group.vaultRoot, "archive", sourceFile)), `${scenario.packageId}: archived source missing`);
  }
  checks.push({ id: group.id, packages: expectedIds.size, receipts: receipts.length, archived: expectedIds.size });
}

assert(result.summary.totalPackages === checks.reduce((sum, item) => sum + item.packages, 0), "result summary package count mismatch");
process.stdout.write(`${JSON.stringify({ ok: true, runId, summary: result.summary, checks }, null, 2)}\n`);

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return "";
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function exists(filePath) {
  try { await stat(filePath); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
