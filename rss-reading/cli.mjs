import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyDecision,
  DEFAULT_WORKFLOW_ROOT,
  generateSummaries,
  getQueue,
  getStatus,
  migrateLegacyOutputs,
  publishSelected,
  runClearanceAudit,
  runCanary
} from "./core.mjs";

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      result._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

async function main() {
  const command = process.argv[2] || "status";
  const options = parseArgs(process.argv.slice(3));
  const workflowRoot = path.resolve(options.root || DEFAULT_WORKFLOW_ROOT);
  let result;
  const previewProgress = ({ completed, total, materialId, status }) => {
    process.stderr.write(`[rss-reading] preview ${completed}/${total} ${materialId} ${status}\n`);
  };
  if (command === "status") result = await getStatus(workflowRoot);
  else if (command === "queue") result = await getQueue(workflowRoot);
  else if (command === "migrate-legacy") result = await migrateLegacyOutputs(workflowRoot, { force: Boolean(options.force) });
  else if (command === "clearance") result = await runClearanceAudit(workflowRoot);
  else if (command === "generate") result = await generateSummaries(workflowRoot, {
    date: options.date,
    week: options.week,
    mode: options.mode || "daily",
    ingestSummaries: !options["skip-summary-ingest"],
    onPreviewProgress: previewProgress
  });
  else if (command === "daily") result = await generateSummaries(workflowRoot, {
    date: options.date,
    mode: "daily",
    ingestSummaries: !options["skip-summary-ingest"],
    onPreviewProgress: previewProgress
  });
  else if (command === "weekly") result = await generateSummaries(workflowRoot, {
    date: options.date,
    week: options.week,
    mode: "weekly",
    ingestSummaries: !options["skip-summary-ingest"],
    onPreviewProgress: previewProgress
  });
  else if (command === "canary") result = await runCanary(workflowRoot, {
    date: options.date,
    week: options.week,
    expectedPackages: options["expected-packages"],
    expectedFulltext: options["expected-fulltext"],
    expectedBlocked: options["expected-blocked"],
    expectedLegacyOutputs: options["expected-legacy-outputs"],
    mode: "all",
    onPreviewProgress: previewProgress
  });
  else if (command === "decision") {
    if (!options["material-id"] || !options.decision) throw new Error("decision_requires_material_id_and_decision");
    result = await applyDecision(workflowRoot, options["material-id"], options.decision, { source: "summary_panel" });
  } else if (command === "publish") {
    if (!options["material-id"]) throw new Error("publish_requires_material_id");
    result = await publishSelected(workflowRoot, options["material-id"]);
  } else {
    result = {
      commands: ["status", "queue", "migrate-legacy", "daily", "weekly", "generate --mode daily|weekly|all", "canary", "clearance", "decision --material-id <id> --decision <state>", "publish --material-id <id>"]
    };
  }
  console.log(JSON.stringify({ ok: true, command, result }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: { code: "rss_reading_failed", message: error.message } }, null, 2));
    process.exitCode = 1;
  });
}
