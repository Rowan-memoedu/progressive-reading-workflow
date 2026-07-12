#!/usr/bin/env node
import fs from "node:fs/promises";
import {
  addMaterialCandidate,
  createLearningProject,
  defaultLearningRoot,
  doctorLearningProject,
  exportLearningProject,
  generateGraphCandidate,
  generateMaterialCandidates,
  getProjectStatus,
  listLearningProjects,
  promoteMaterialCandidate,
  rebuildProject,
  recordLearningEvidence,
  replaceGraph,
  resolveProject
} from "./learning-project-core.mjs";

const args = process.argv.slice(2);
const command = args.shift() || "help";

function option(name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function flag(name) { return args.includes(`--${name}`); }
function positional() { return args.find((item) => !item.startsWith("--") && !args[args.indexOf(item) - 1]?.startsWith("--")); }
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function main() {
  if (command === "create") {
    return print(await createLearningProject({
      repoUrl: option("repo"),
      goal: option("goal", undefined),
      root: option("root", defaultLearningRoot),
      sourceDir: option("source-dir"),
      fetchReading: flag("fetch-reading"),
      clone: flag("clone")
    }));
  }
  if (command === "list") return print(await listLearningProjects(option("root", defaultLearningRoot)));
  if (command === "help") {
    return print({
      usage: [
        "learning-project.mjs create --repo <github-root-url> [--goal <text>] [--source-dir <path>] [--clone] [--fetch-reading]",
        "learning-project.mjs doctor <project-id-or-path> [--apply]",
        "learning-project.mjs status <project-id-or-path>",
        "learning-project.mjs graph <project-id-or-path> --file <graph.json>",
        "learning-project.mjs graph-generate <project> --source <file> [--source <file>...] [--apply]",
        "learning-project.mjs record <project> --concept <id> --task <id> --result pass|fail --verification verified|self_report|system [--source <pointer>]",
        "learning-project.mjs material-generate <project> --source <file> [--source <file>...] [--count 6]",
        "learning-project.mjs material-add <project> --file <material.json>",
        "learning-project.mjs material-promote <project> --material <id> --evidence user_review|successful_answer [--note <text>]",
        "learning-project.mjs export <project>",
        "learning-project.mjs list"
      ]
    });
  }
  const projectDir = await resolveProject(positional(), option("root", defaultLearningRoot));
  const sourceFiles = args.flatMap((item, index) => item === "--source" && args[index + 1] ? [args[index + 1]] : []);
  if (command === "doctor") return print(await doctorLearningProject(projectDir, { apply: flag("apply") }));
  if (command === "status") return print(await getProjectStatus(projectDir));
  if (command === "rebuild") return print(await rebuildProject(projectDir));
  if (command === "graph") return print(await replaceGraph(projectDir, JSON.parse(await fs.readFile(option("file"), "utf8"))));
  if (command === "graph-generate") return print(await generateGraphCandidate(projectDir, { sourceFiles, apply: flag("apply") }));
  if (command === "record") return print(await recordLearningEvidence(projectDir, {
    conceptId: option("concept"), taskId: option("task"), result: option("result"),
    verification: option("verification"), sourcePointer: option("source"), note: option("note")
  }));
  if (command === "material-add") return print(await addMaterialCandidate(projectDir, JSON.parse(await fs.readFile(option("file"), "utf8"))));
  if (command === "material-generate") return print(await generateMaterialCandidates(projectDir, { sourceFiles, count: Number(option("count", "6")) }));
  if (command === "material-promote") return print(await promoteMaterialCandidate(projectDir, option("material"), { type: option("evidence"), note: option("note") }));
  if (command === "export") return print(await exportLearningProject(projectDir));
  throw new Error(`unknown_command_${command}`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exit(1);
});
