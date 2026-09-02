#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  isReadyResult,
  publishReadingArtifact,
  validateResultContract,
  writeJsonArtifact
} from "../standard-preprocessing/index.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readingRoot = path.join(projectRoot, "阅读区");
const auditRoot = path.join(projectRoot, "imports", "preprocess-runs");

function parseArgs(argv) {
  const args = { sourceRun: "", auditRun: "", publish: "", assetSubdir: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source-run") args.sourceRun = argv[++index] || "";
    else if (arg === "--audit-run") args.auditRun = argv[++index] || "";
    else if (arg === "--publish") args.publish = argv[++index] || "";
    else if (arg === "--asset-subdir") args.assetSubdir = argv[++index] || "";
    else throw new Error(`unknown_argument:${arg}`);
  }
  for (const key of ["sourceRun", "auditRun", "publish"]) {
    if (!args[key]) throw new Error(`missing_argument:${key}`);
  }
  return args;
}

function assertWithin(root, target, label, { allowSame = false } = {}) {
  const relative = path.relative(root, target);
  const outside = relative.startsWith("..") || path.isAbsolute(relative);
  if (outside || (!allowSame && relative === "")) {
    throw new Error(`${label}_outside_allowed_root:${target}`);
  }
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function verifyManifest(runDir, manifest) {
  const verified = [];
  for (const [name, record] of Object.entries(manifest.files || {})) {
    const relative = String(record.relative_path || name);
    const target = path.resolve(runDir, relative);
    assertWithin(runDir, target, "manifest_file", { allowSame: false });
    const data = await fs.readFile(target);
    const actual = { bytes: data.byteLength, sha256: sha256(data) };
    if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256) {
      throw new Error(`manifest_hash_mismatch:${relative}`);
    }
    verified.push({ relative_path: relative, ...actual });
  }
  if (!verified.some((record) => record.relative_path === "reading.md")) {
    throw new Error("manifest_missing_reading_markdown");
  }
  return verified;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRun = path.resolve(args.sourceRun);
  const auditRun = path.resolve(args.auditRun);
  const publishPath = path.resolve(args.publish);

  assertWithin(readingRoot, sourceRun, "source_run");
  assertWithin(auditRoot, auditRun, "audit_run");
  assertWithin(readingRoot, publishPath, "publish_path");
  if (path.extname(publishPath).toLowerCase() !== ".md") throw new Error("publish_path_must_be_markdown");
  if (!await exists(sourceRun)) throw new Error(`source_run_missing:${sourceRun}`);
  if (await exists(auditRun)) throw new Error(`audit_run_already_exists:${auditRun}`);
  if (await exists(publishPath)) throw new Error(`publish_path_already_exists:${publishPath}`);

  const result = JSON.parse(await fs.readFile(path.join(sourceRun, "result.json"), "utf8"));
  const manifest = JSON.parse(await fs.readFile(path.join(sourceRun, "run-manifest.json"), "utf8"));
  const resultValidation = await validateResultContract(result);
  if (!resultValidation.valid) throw new Error("result_contract_invalid");
  if (!isReadyResult(result)) throw new Error("result_not_ready_for_publication");
  const verifiedBeforeMove = await verifyManifest(sourceRun, manifest);

  await fs.mkdir(path.dirname(auditRun), { recursive: true });
  await fs.rename(sourceRun, auditRun);

  for (const [name, record] of Object.entries(manifest.files || {})) {
    record.path = path.join(auditRun, String(record.relative_path || name));
  }
  await writeJsonArtifact(path.join(auditRun, "run-manifest.json"), manifest);
  const verifiedAfterMove = await verifyManifest(auditRun, manifest);

  let assetSourceDir = null;
  if (args.assetSubdir) {
    assetSourceDir = path.resolve(auditRun, args.assetSubdir);
    assertWithin(auditRun, assetSourceDir, "asset_source");
    if (!await exists(assetSourceDir)) throw new Error(`asset_source_missing:${assetSourceDir}`);
  }
  const publication = await publishReadingArtifact(result, {
    publishPath,
    assetSourceDir,
    runDir: auditRun
  });

  const migration = {
    schema_version: "progressive-reading.preprocess.layout-migration/v1",
    migrated_at: new Date().toISOString(),
    source_run: sourceRun,
    audit_run: auditRun,
    publish_path: publishPath,
    source_removed_from_reading_area: !await exists(sourceRun),
    manifest_files_verified_before_move: verifiedBeforeMove,
    manifest_files_verified_after_move: verifiedAfterMove,
    publication
  };
  await writeJsonArtifact(path.join(auditRun, "layout-migration.json"), migration);
  process.stdout.write(`${JSON.stringify(migration)}\n`);
}

await main();
