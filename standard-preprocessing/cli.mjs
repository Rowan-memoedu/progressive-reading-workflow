#!/usr/bin/env node
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  CALLABLE_INTERFACE_VERSION,
  PreprocessInterfaceError,
  buildSplitManifest,
  buildSplitRequest,
  getDoctorReport,
  isReadyResult,
  runPreprocessingRequest,
  validateRequestContract,
  validateSplitManifestContract,
  writeJsonArtifact
} from "./index.mjs";
import { FixtureProducer } from "./lib/producer.mjs";

function parseArgs(argv) {
  const parsed = {
    command: "",
    request: "",
    output: "",
    publish: "",
    assetSource: "",
    cache: "",
    fixtureResponse: "",
    provider: "",
    plan: "",
    manifest: "",
    splitId: "",
    json: false,
    help: false,
    strict: false,
    dryRun: false,
    noWrite: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--request") parsed.request = argv[++index] || "";
    else if (arg === "--output") parsed.output = argv[++index] || "";
    else if (arg === "--publish") parsed.publish = argv[++index] || "";
    else if (arg === "--asset-source") parsed.assetSource = argv[++index] || "";
    else if (arg === "--cache") parsed.cache = argv[++index] || "";
    else if (arg === "--fixture-response") parsed.fixtureResponse = argv[++index] || "";
    else if (arg === "--provider") {
      parsed.provider = argv[++index] || "";
      if (!['codex_exec', 'deepseek'].includes(parsed.provider)) throw new PreprocessInterfaceError('invalid_provider', '--provider must be codex_exec or deepseek');
    }
    else if (arg === "--plan") parsed.plan = argv[++index] || "";
    else if (arg === "--manifest") parsed.manifest = argv[++index] || "";
    else if (arg === "--split-id") parsed.splitId = argv[++index] || "";
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--strict") parsed.strict = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--no-write") parsed.noWrite = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (!arg.startsWith("-") && !parsed.command) parsed.command = arg;
    else throw new PreprocessInterfaceError("unknown_argument", `unknown argument: ${arg}`);
  }
  if (!parsed.command && parsed.request) parsed.command = "run";
  return parsed;
}

function usage() {
  return [
    "pr-preprocess — standard progressive-reading Markdown preprocessing",
    "",
    "Commands:",
    "  pr-preprocess --json doctor",
    "  pr-preprocess --json validate --request <request.json|->",
    "  pr-preprocess --json split --request <request.json> --output <split-manifest.json> [--plan <split-plan.json>]",
    "  pr-preprocess --json split-request --request <request.json> --manifest <split-manifest.json> --split-id <id> --output <child-request.json>",
    "  pr-preprocess --json run --request <request.json|-> --output <audit-run-dir> [--publish <final.md>] [--asset-source <assets-dir>] [--cache <cache-dir>] [--strict]",
    "",
    "Run options:",
    "  --provider             codex_exec (default) or deepseek; overrides this invocation only",
    "  --dry-run              Validate only; do not call AI or write files",
    "  --no-write             Return the processed summary without writing an output directory",
    "  --publish              Publish the ready Markdown as one exact .md file; keep run artifacts under --output",
    "  --asset-source         Source directory for relative assets/... image links used by --publish",
    "  --fixture-response     Testing only: use a local producer-output JSON fixture",
    "  --strict               Exit 2 unless the result is ready for local-ir-reading",
    "",
    "Compatibility:",
    "  The previous form without the 'run' subcommand remains supported.",
    "  node standard-preprocessing/cli.mjs --request <request.json> --output <audit-run-dir> --json"
  ].join("\n");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function loadJson(filePath) {
  if (!filePath) throw new PreprocessInterfaceError("missing_request_path", "--request is required");
  const text = filePath === "-" ? await readStdin() : await fs.readFile(path.resolve(filePath), "utf8");
  try {
    return JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new PreprocessInterfaceError("invalid_json", `could not parse JSON from ${filePath}`, {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function runSummary(run) {
  const result = run.result;
  return {
    ok: true,
    command: "run",
    interface_version: CALLABLE_INTERFACE_VERSION,
    ready: isReadyResult(result),
    status: result.status,
    material_id: result.material_id,
    idempotency_key: result.idempotency_key,
    processing_state: result.processing_state,
    translation_state: result.translation_state,
    target_zone: result.artifacts?.target_zone || null,
    needs_classification: result.status === "needs_classification",
    missing_labels: result.receipt?.workflow_route?.missing_labels || [],
    processing_plan: result.receipt?.workflow_route?.plan || null,
    output_dir: run.output_dir,
    publication: run.publication,
    files: run.files,
    receipt: {
      processor_version: result.receipt?.processor_version || null,
      prompt_version: result.receipt?.prompt_version || null,
      model_calls: result.receipt?.model?.calls ?? null,
      reading_guide: result.receipt?.reading_guide || null,
      validations: result.receipt?.validations || []
    },
    errors: result.errors || []
  };
}

function printHuman(value) {
  if (value.command === "doctor") {
    console.log(`ready=${value.ready}\nnode=${value.runtime.node}\nproducer=${value.producer.ready ? "ready" : "missing"}\ninterface_version=${value.interface_version}`);
    return;
  }
  if (value.command === "validate") {
    console.log(`valid=${value.valid}\nrequest_schema=${value.validation.schema.version}`);
    return;
  }
  if (value.command === "split" || value.command === "split-request") {
    console.log(`command=${value.command}\noutput=${value.output}\nsplit_count=${value.split_count ?? "n/a"}`);
    return;
  }
  console.log([
    `status=${value.status}`,
    `ready=${value.ready}`,
    `material_id=${value.material_id}`,
    `processing_state=${value.processing_state}`,
    `target_zone=${value.target_zone}`,
    ...(value.needs_classification ? [`待补充分类：${value.missing_labels.join(", ")}`, "修改请求中的分类字段或处理选择后，使用相同输入继续运行。"] : []),
    `output_dir=${value.output_dir || "not_written"}`,
    `published_markdown=${value.publication?.markdown?.path || "not_published"}`
  ].join("\n"));
}

async function execute(args) {
  if (args.provider) process.env.AI_PRODUCER_PROVIDER = args.provider;
  if (args.command === "doctor") {
    const report = await getDoctorReport();
    return { ok: true, command: "doctor", ...report };
  }
  if (args.command === "validate") {
    const request = await loadJson(args.request);
    const validation = await validateRequestContract(request);
    return { ok: true, command: "validate", interface_version: CALLABLE_INTERFACE_VERSION, valid: validation.valid, validation };
  }
  if (args.command === "split") {
    const request = await loadJson(args.request);
    const validation = await validateRequestContract(request);
    if (!validation.valid) throw new PreprocessInterfaceError("request_contract_violation", "split request does not satisfy the published request contract", validation);
    const plan = args.plan ? await loadJson(args.plan) : {};
    if (!args.output) throw new PreprocessInterfaceError("missing_output_path", "--output is required for split");
    const manifest = buildSplitManifest(request, plan);
    const manifestValidation = await validateSplitManifestContract(manifest);
    if (!manifestValidation.valid) throw new PreprocessInterfaceError("split_manifest_contract_violation", "generated split manifest does not satisfy its published contract", manifestValidation);
    const output = await writeJsonArtifact(args.output, manifest);
    return { ok: true, command: "split", interface_version: CALLABLE_INTERFACE_VERSION, output, split_count: manifest.split_count, manifest };
  }
  if (args.command === "split-request") {
    if (!args.manifest) throw new PreprocessInterfaceError("missing_manifest_path", "--manifest is required for split-request");
    const request = await loadJson(args.request);
    const validation = await validateRequestContract(request);
    if (!validation.valid) throw new PreprocessInterfaceError("request_contract_violation", "split request does not satisfy the published request contract", validation);
    const manifest = await loadJson(args.manifest);
    const manifestValidation = await validateSplitManifestContract(manifest);
    if (!manifestValidation.valid) throw new PreprocessInterfaceError("split_manifest_contract_violation", "split manifest does not satisfy its published contract", manifestValidation);
    if (!args.splitId) throw new PreprocessInterfaceError("missing_split_id", "--split-id is required for split-request");
    if (!args.output) throw new PreprocessInterfaceError("missing_output_path", "--output is required for split-request");
    const child = buildSplitRequest(request, manifest, args.splitId);
    const output = await writeJsonArtifact(args.output, child);
    return { ok: true, command: "split-request", interface_version: CALLABLE_INTERFACE_VERSION, output, split_id: args.splitId };
  }
  if (args.command !== "run") {
    throw new PreprocessInterfaceError("unknown_command", `unknown command: ${args.command || "<none>"}`);
  }
  const request = await loadJson(args.request);
  if (args.dryRun) {
    const validation = await validateRequestContract(request);
    return { ok: true, command: "validate", dry_run: true, interface_version: CALLABLE_INTERFACE_VERSION, valid: validation.valid, validation };
  }
  if (!args.output && !args.noWrite) {
    throw new PreprocessInterfaceError("missing_output_directory", "--output is required unless --no-write is used");
  }
  if (args.publish && args.noWrite) {
    throw new PreprocessInterfaceError("publish_requires_output", "--publish requires an audit directory supplied with --output");
  }
  if (args.assetSource && !args.publish) {
    throw new PreprocessInterfaceError("asset_source_requires_publish", "--asset-source may only be used with --publish");
  }
  const producer = args.fixtureResponse
    ? new FixtureProducer(await loadJson(args.fixtureResponse))
    : undefined;
  const run = await runPreprocessingRequest(request, {
    producer,
    outputDir: args.noWrite ? null : path.resolve(args.output),
    publishPath: args.publish ? path.resolve(args.publish) : undefined,
    assetSourceDir: args.assetSource ? path.resolve(args.assetSource) : undefined,
    cacheDir: args.cache ? path.resolve(args.cache) : undefined
  });
  return runSummary(run);
}

export async function main(argv = process.argv.slice(2)) {
  let args = { json: argv.includes("--json") };
  try {
    args = parseArgs(argv);
    if (args.help || !args.command) {
      console.log(usage());
      return 0;
    }
    const output = await execute(args);
    if (args.json) console.log(JSON.stringify(output));
    else printHuman(output);
    if (output.command === "validate" && !output.valid) return 1;
    if (output.status === "needs_classification") return 3;
    if (args.strict && output.command === "run" && !output.ready) return 2;
    return 0;
  } catch (error) {
    const envelope = {
      ok: false,
      command: args.command || null,
      interface_version: CALLABLE_INTERFACE_VERSION,
      error: {
        code: error?.code || "unhandled_error",
        message: error instanceof Error ? error.message : String(error),
        details: error?.details || null
      }
    };
    if (args.json) console.log(JSON.stringify(envelope));
    else console.error(`${envelope.error.code}: ${envelope.error.message}`);
    return 1;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]));
  } catch {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  }
}

if (isMainModule()) {
  process.exitCode = await main();
}
