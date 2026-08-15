import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { processMaterial } from "./lib/core.mjs";
import { FixtureProducer } from "./lib/producer.mjs";

function parseArgs(argv) {
  const parsed = { request: "", output: "", cache: "", fixtureResponse: "", json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--request") parsed.request = argv[++index] || "";
    else if (arg === "--output") parsed.output = argv[++index] || "";
    else if (arg === "--cache") parsed.cache = argv[++index] || "";
    else if (arg === "--fixture-response") parsed.fixtureResponse = argv[++index] || "";
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`unknown_argument_${arg}`);
  }
  return parsed;
}

function usage() {
  return [
    "Standard progressive-reading Markdown preprocessing interface",
    "",
    "Usage:",
    "  node standard-preprocessing/cli.mjs --request <request.json> --output <run-dir> [--cache <cache-dir>] [--json]",
    "  node standard-preprocessing/cli.mjs --request - --output <run-dir>",
    "",
    "Testing only:",
    "  --fixture-response <producer-output.json>"
  ].join("\n");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function loadJson(filePath) {
  const text = filePath === "-" ? await readStdin() : await fs.readFile(path.resolve(filePath), "utf8");
  return JSON.parse(text.replace(/^\uFEFF/u, ""));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.request) throw new Error("missing_request_path");
  if (!args.output) throw new Error("missing_output_directory");
  const request = await loadJson(args.request);
  const outputDir = path.resolve(args.output);
  const cacheDir = args.cache ? path.resolve(args.cache) : path.join(outputDir, ".idempotency");
  const producer = args.fixtureResponse
    ? new FixtureProducer(await loadJson(args.fixtureResponse))
    : undefined;
  const result = await processMaterial(request, { producer, cacheDir });
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  if (result.artifacts?.reading_markdown) {
    await fs.writeFile(path.join(outputDir, "reading.md"), result.artifacts.reading_markdown, "utf8");
  }
  if (result.artifacts?.quarantine_markdown) {
    await fs.writeFile(path.join(outputDir, "quarantine.md"), result.artifacts.quarantine_markdown, "utf8");
  }
  const summary = {
    status: result.status,
    material_id: result.material_id,
    idempotency_key: result.idempotency_key,
    processing_state: result.processing_state,
    translation_state: result.translation_state,
    output_dir: outputDir,
    errors: result.errors
  };
  console.log(args.json ? JSON.stringify(summary) : [
    `status=${summary.status}`,
    `material_id=${summary.material_id}`,
    `processing_state=${summary.processing_state}`,
    `translation_state=${summary.translation_state}`,
    `output_dir=${summary.output_dir}`
  ].join("\n"));
  if (result.status === "failed") process.exitCode = 1;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}

