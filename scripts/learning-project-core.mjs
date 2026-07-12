import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const workflowRoot = path.resolve(__dirname, "..");
export const defaultLearningRoot = path.join(workflowRoot, "imports", "learning-projects");
const importerPath = path.join(__dirname, "import-web-md.mjs");

const nowIso = () => new Date().toISOString();
const hash = (value, length = 12) => createHash("sha256").update(String(value)).digest("hex").slice(0, length);
const normalizeText = (value) => String(value || "").trim().replace(/\s+/g, " ");

function safeName(value, fallback = "learning-project") {
  const cleaned = normalizeText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (cleaned || fallback).slice(0, 100);
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(target, fallback = null) {
  const hasFallback = arguments.length >= 2;
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if (hasFallback && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function run(command, args, { cwd = workflowRoot, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`command_timeout_${safeName(command)}_${timeoutMs}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`command_failed_${safeName(command)}_${code}: ${normalizeText(stderr || stdout).slice(0, 1200)}`));
    });
  });
}

export function parseGithubRepoUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("invalid_github_repository_url");
  }
  if (!["github.com", "www.github.com"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("repository_must_use_github_com");
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error("github_repository_url_must_be_root");
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("invalid_github_owner_or_repository");
  }
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

export function defaultGraph() {
  return {
    schema: "learning-concept-graph/v1",
    concepts: [
      { id: "environment", title: "开发环境与项目工具链", prerequisites: [], order: 10 },
      { id: "repository-map", title: "仓库结构与核心边界", prerequisites: ["environment"], order: 20 },
      { id: "execution-path", title: "一条真实执行路径", prerequisites: ["repository-map"], order: 30 },
      { id: "verified-change", title: "完成并解释一项可验证改动", prerequisites: ["execution-path"], order: 40 }
    ],
    tasks: [
      { id: "environment-doctor", conceptId: "environment", type: "setup", title: "运行环境预检并处理阻塞项", activeRecall: false, verification: "全部必需工具检查通过" },
      { id: "predict-repository-map", conceptId: "repository-map", type: "prediction", title: "先预测核心目录职责，再用源码验证", activeRecall: true, verification: "目录判断带源码路径并能解释边界" },
      { id: "trace-execution-path", conceptId: "execution-path", type: "trace", title: "独立追踪一条真实用户操作或程序执行路径", activeRecall: true, verification: "给出入口、关键跳转、状态变化与测试证据" },
      { id: "make-verified-change", conceptId: "verified-change", type: "project", title: "完成一项小型可验证改动并解释设计", activeRecall: true, verification: "测试通过且能说明改动、风险与回滚" }
    ]
  };
}

function validateGraph(graph) {
  if (!graph || graph.schema !== "learning-concept-graph/v1") throw new Error("invalid_graph_schema");
  if (!Array.isArray(graph.concepts) || !graph.concepts.length) throw new Error("graph_requires_concepts");
  if (!Array.isArray(graph.tasks) || !graph.tasks.length) throw new Error("graph_requires_tasks");
  const ids = new Set();
  for (const concept of graph.concepts) {
    if (!concept.id || !concept.title || ids.has(concept.id)) throw new Error("invalid_or_duplicate_concept");
    ids.add(concept.id);
  }
  for (const concept of graph.concepts) {
    for (const prerequisite of concept.prerequisites || []) {
      if (!ids.has(prerequisite) || prerequisite === concept.id) throw new Error(`invalid_prerequisite_${concept.id}_${prerequisite}`);
    }
  }
  const taskIds = new Set();
  for (const task of graph.tasks) {
    if (!task.id || !task.title || !ids.has(task.conceptId) || taskIds.has(task.id)) throw new Error("invalid_or_duplicate_task");
    taskIds.add(task.id);
  }
  return graph;
}

function manifestPath(projectDir) { return path.join(projectDir, "manifest.json"); }
function graphPath(projectDir) { return path.join(projectDir, "concept-graph.json"); }
function eventsPath(projectDir) { return path.join(projectDir, "events.jsonl"); }
function statePath(projectDir) { return path.join(projectDir, "state.json"); }

export async function resolveProject(projectOrId, root = defaultLearningRoot) {
  const direct = path.resolve(String(projectOrId || ""));
  const projectDir = await exists(path.join(direct, "manifest.json")) ? direct : path.join(root, safeName(projectOrId));
  if (!(await exists(manifestPath(projectDir)))) throw new Error(`learning_project_not_found_${safeName(projectOrId)}`);
  return projectDir;
}

export async function appendEvent(projectDir, event) {
  const payload = {
    id: event.id || randomUUID(),
    at: event.at || nowIso(),
    ...event
  };
  await fs.appendFile(eventsPath(projectDir), `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
}

export async function readEvents(projectDir) {
  const text = await fs.readFile(eventsPath(projectDir), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`invalid_event_json_line_${index + 1}`); }
  });
}

export function deriveConceptStates(graph, events) {
  const states = Object.fromEntries(graph.concepts.map((concept) => [concept.id, {
    conceptId: concept.id,
    status: "unknown",
    successes: 0,
    verifiedSuccesses: 0,
    failures: 0,
    lastEvidenceAt: null
  }]));
  for (const event of events) {
    if (event.type !== "learning_evidence" || !states[event.conceptId]) continue;
    const state = states[event.conceptId];
    state.lastEvidenceAt = event.at || state.lastEvidenceAt;
    if (event.result === "pass") {
      state.successes += 1;
      if (event.verification === "verified") state.verifiedSuccesses += 1;
      state.status = state.verifiedSuccesses >= 1 && state.successes >= 2 ? "demonstrated" : "learning";
    } else if (event.result === "fail") {
      state.failures += 1;
      state.status = "needs_remediation";
    }
  }
  return states;
}

function unresolvedPrerequisite(concept, states) {
  return (concept.prerequisites || []).find((id) => states[id]?.status !== "demonstrated") || null;
}

export function chooseNextTask(graph, states) {
  const concepts = [...graph.concepts].sort((a, b) => (a.order || 0) - (b.order || 0));
  const remediation = concepts.find((concept) => states[concept.id]?.status === "needs_remediation");
  if (remediation) {
    const prerequisiteId = unresolvedPrerequisite(remediation, states);
    const targetId = prerequisiteId || remediation.id;
    const task = graph.tasks.find((item) => item.conceptId === targetId);
    return { task, reason: prerequisiteId ? `remediate_prerequisite_for_${remediation.id}` : `retry_failed_${remediation.id}` };
  }
  for (const concept of concepts) {
    if (states[concept.id]?.status === "demonstrated") continue;
    const prerequisiteId = unresolvedPrerequisite(concept, states);
    if (prerequisiteId) continue;
    const task = graph.tasks.find((item) => item.conceptId === concept.id);
    if (task) return { task, reason: states[concept.id]?.status === "learning" ? "continue_until_demonstrated" : "next_ready_concept" };
  }
  return { task: null, reason: "all_current_concepts_demonstrated" };
}

export async function rebuildProject(projectDir) {
  const manifest = await readJson(manifestPath(projectDir));
  const graph = validateGraph(await readJson(graphPath(projectDir)));
  const events = await readEvents(projectDir);
  const conceptStates = deriveConceptStates(graph, events);
  const next = chooseNextTask(graph, conceptStates);
  const state = {
    schema: "learning-project-state/v1",
    projectId: manifest.id,
    rebuiltAt: nowIso(),
    eventCount: events.length,
    conceptStates,
    nextTask: next.task,
    nextReason: next.reason
  };
  await writeJson(statePath(projectDir), state);
  manifest.updatedAt = state.rebuiltAt;
  manifest.status = next.task ? "active" : "current_graph_complete";
  await writeJson(manifestPath(projectDir), manifest);
  return { manifest, graph, state };
}

async function importReadingPackage(repoUrl, targetDir) {
  const { stdout } = await run(process.execPath, [importerPath, repoUrl, "--out", targetDir, "--instruction", "为项目学习保留完整 Markdown 结构与来源，不生成无依据内容。"], {
    cwd: workflowRoot,
    timeoutMs: 15 * 60 * 1000
  });
  const summary = JSON.parse(stdout);
  if (!Array.isArray(summary) || !summary.some((item) => ["imported", "partial"].includes(item.status))) {
    throw new Error("learning_project_reading_import_failed");
  }
  return summary;
}

async function cloneRepository(repo, targetDir) {
  if (await exists(targetDir)) return { status: "exists", target: targetDir };
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await run("git", ["clone", "--depth", "1", repo.url, targetDir], { timeoutMs: 15 * 60 * 1000 });
  return { status: "cloned", target: targetDir };
}

export async function createLearningProject({
  repoUrl,
  goal = "理解项目并完成一项可验证改动",
  root = defaultLearningRoot,
  sourceDir = "",
  fetchReading = false,
  clone = false
}) {
  const repo = parseGithubRepoUrl(repoUrl);
  const id = `${safeName(`${repo.owner}-${repo.repo}`).toLowerCase()}-${hash(repo.url, 8)}`;
  const projectDir = path.join(root, id);
  const existing = await readJson(manifestPath(projectDir), null);
  if (existing) return { projectDir, manifest: existing, created: false, state: await readJson(statePath(projectDir), null) };
  await fs.mkdir(path.join(projectDir, "materials", "candidates"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "remnote-promotion-queue"), { recursive: true });
  const readingPackagePath = path.join(projectDir, "reading-package");
  const workspacePath = sourceDir ? path.resolve(sourceDir) : path.join(projectDir, "workspace");
  const manifest = {
    schema: "learning-project/v1",
    id,
    title: `${repo.owner}/${repo.repo}`,
    goal: normalizeText(goal),
    outcome: "real_verified_output",
    status: "created",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    source: {
      type: "github_repository",
      ...repo,
      workspacePath,
      readingPackagePath,
      workspaceManaged: !sourceDir
    },
    stateAuthority: "local_manifest_and_event_ledger",
    durableKnowledgeTarget: "remnote_after_explicit_promotion",
    teachingFriction: "selective_active_recall",
    promotionPolicy: "candidate_first"
  };
  await writeJson(manifestPath(projectDir), manifest);
  await writeJson(graphPath(projectDir), defaultGraph());
  await fs.writeFile(eventsPath(projectDir), "", "utf8");
  await appendEvent(projectDir, { type: "project_created", repoUrl: repo.url, goal: manifest.goal });
  if (clone && !sourceDir) {
    const result = await cloneRepository(repo, workspacePath);
    await appendEvent(projectDir, { type: "repository_clone", result: result.status, target: result.target });
  }
  if (fetchReading) {
    const summary = await importReadingPackage(repo.url, readingPackagePath);
    await appendEvent(projectDir, { type: "reading_package_import", result: "pass", summary });
  }
  const rebuilt = await rebuildProject(projectDir);
  return { projectDir, manifest: rebuilt.manifest, state: rebuilt.state, created: true };
}

async function commandCheck(command, args = ["--version"]) {
  try {
    const result = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)
      ? await run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `${command} ${args.join(" ")}`], { timeoutMs: 8000 })
      : await run(command, args, { timeoutMs: 8000 });
    return { command, ok: true, version: normalizeText(result.stdout || result.stderr).slice(0, 240) };
  } catch (error) {
    return { command, ok: false, error: error.message };
  }
}

async function projectSignals(workspacePath) {
  const files = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "Makefile", "README.md"];
  const present = [];
  for (const name of files) if (await exists(path.join(workspacePath, name))) present.push(name);
  return present;
}

export async function doctorLearningProject(projectDir, { apply = false } = {}) {
  const manifest = await readJson(manifestPath(projectDir));
  const workspacePath = manifest.source.workspacePath;
  const workspaceExists = await exists(workspacePath);
  const signals = workspaceExists ? await projectSignals(workspacePath) : [];
  const required = new Map([["git", ["--version"]]]);
  if (manifest.source.workspaceManaged) required.set("gh", ["--version"]);
  if (signals.includes("package.json")) {
    required.set("node", ["--version"]);
    required.set(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"]);
  }
  if (signals.some((name) => ["pyproject.toml", "requirements.txt"].includes(name))) required.set("python", ["--version"]);
  if (signals.includes("Cargo.toml")) required.set("cargo", ["--version"]);
  if (signals.includes("go.mod")) required.set("go", ["version"]);
  const checks = [];
  for (const [command, args] of required) checks.push(await commandCheck(command, args));
  const actions = [];
  if (!workspaceExists) actions.push({ id: "fetch_workspace", owner: "ai", text: "克隆项目工作区后重新预检。" });
  for (const check of checks.filter((item) => !item.ok)) {
    actions.push({ id: `install_${safeName(check.command)}`, owner: "user_if_ai_cannot", text: `安装或修复 ${check.command}，然后确认版本命令可运行。` });
  }
  const autoFixes = [];
  if (apply && workspaceExists && signals.includes("package.json") && !(await exists(path.join(workspacePath, "node_modules")))) {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const npmCheck = checks.find((item) => item.command === npmCommand);
    if (npmCheck?.ok) {
      try {
        if (process.platform === "win32") {
          await run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd install"], { cwd: workspacePath, timeoutMs: 20 * 60 * 1000 });
        } else {
          await run(npmCommand, ["install"], { cwd: workspacePath, timeoutMs: 20 * 60 * 1000 });
        }
        autoFixes.push({ id: "npm_install", status: "applied", target: workspacePath });
      } catch (error) {
        autoFixes.push({ id: "npm_install", status: "failed", error: error.message });
        actions.push({ id: "npm_install_failed", owner: "ai", text: "分析 npm install 失败日志并切换安装路线。" });
      }
    }
  }
  const report = {
    schema: "learning-environment-report/v1",
    projectId: manifest.id,
    checkedAt: nowIso(),
    workspacePath,
    workspaceExists,
    signals,
    checks,
    autoFixes,
    userActions: actions,
    status: workspaceExists && checks.every((item) => item.ok) ? "ready" : "needs_action"
  };
  await writeJson(path.join(projectDir, "environment-report.json"), report);
  await appendEvent(projectDir, { type: "environment_doctor", result: report.status === "ready" ? "pass" : "needs_action", report: "environment-report.json" });
  if (report.status === "ready") {
    await appendEvent(projectDir, { type: "learning_evidence", conceptId: "environment", taskId: "environment-doctor", result: "pass", verification: "verified", sourcePointer: "environment-report.json" });
    await appendEvent(projectDir, { type: "learning_evidence", conceptId: "environment", taskId: "environment-doctor", result: "pass", verification: "system", sourcePointer: "environment-report.json" });
  }
  await rebuildProject(projectDir);
  return report;
}

export async function replaceGraph(projectDir, graph) {
  validateGraph(graph);
  await writeJson(graphPath(projectDir), graph);
  await appendEvent(projectDir, { type: "graph_replaced", conceptCount: graph.concepts.length, taskCount: graph.tasks.length });
  return rebuildProject(projectDir);
}

export async function recordLearningEvidence(projectDir, evidence) {
  const graph = validateGraph(await readJson(graphPath(projectDir)));
  if (!graph.concepts.some((item) => item.id === evidence.conceptId)) throw new Error("evidence_unknown_concept");
  if (!graph.tasks.some((item) => item.id === evidence.taskId && item.conceptId === evidence.conceptId)) throw new Error("evidence_task_concept_mismatch");
  if (!["pass", "fail"].includes(evidence.result)) throw new Error("evidence_result_must_be_pass_or_fail");
  if (!["verified", "self_report", "system"].includes(evidence.verification)) throw new Error("invalid_evidence_verification");
  if (evidence.verification === "verified" && !normalizeText(evidence.sourcePointer)) throw new Error("verified_evidence_requires_source_pointer");
  const event = await appendEvent(projectDir, { type: "learning_evidence", ...evidence, note: normalizeText(evidence.note) });
  const rebuilt = await rebuildProject(projectDir);
  return { event, state: rebuilt.state };
}

export async function getProjectStatus(projectDir) {
  return rebuildProject(projectDir);
}

function validateMaterial(material, graph, existing = []) {
  const errors = [];
  if (!["flashcard", "quiz"].includes(material.kind)) errors.push("invalid_kind");
  if (!normalizeText(material.prompt)) errors.push("missing_prompt");
  if (!normalizeText(material.answer)) errors.push("missing_answer");
  if (!normalizeText(material.objective)) errors.push("missing_objective");
  if (!graph.concepts.some((item) => item.id === material.conceptId)) errors.push("unknown_concept");
  if (!Array.isArray(material.sourcePointers) || !material.sourcePointers.some((item) => normalizeText(item?.path || item?.url))) errors.push("missing_source_pointer");
  const normalizedPrompt = normalizeText(material.prompt).toLowerCase();
  const fingerprint = hash(normalizedPrompt, 20);
  if (existing.some((item) => (
    item.fingerprint === fingerprint
    || item.validation?.fingerprint === fingerprint
    || normalizeText(item.prompt).toLowerCase() === normalizedPrompt
  ))) errors.push("duplicate_prompt");
  if (material.kind === "quiz" && material.format === "multiple_choice") {
    const distractors = (material.distractors || []).map(normalizeText).filter(Boolean);
    if (new Set(distractors).size < 2 || distractors.includes(normalizeText(material.answer))) errors.push("invalid_distractors");
  }
  return { passed: errors.length === 0, errors, fingerprint };
}

async function listCandidateMaterials(projectDir) {
  const dir = path.join(projectDir, "materials", "candidates");
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const values = [];
  for (const entry of entries) if (entry.isFile() && entry.name.endsWith(".json")) values.push(await readJson(path.join(dir, entry.name)));
  return values;
}

export async function addMaterialCandidate(projectDir, material) {
  const graph = validateGraph(await readJson(graphPath(projectDir)));
  const existing = await listCandidateMaterials(projectDir);
  const validation = validateMaterial(material, graph, existing);
  const baseId = material.id || `${material.kind || "material"}-${validation.fingerprint}`;
  const id = validation.passed ? baseId : `${baseId}-rejected-${randomUUID().slice(0, 8)}`;
  const candidate = {
    schema: "learning-material-candidate/v1",
    id,
    createdAt: nowIso(),
    status: validation.passed ? "candidate" : "rejected",
    ...material,
    validation
  };
  await writeJson(path.join(projectDir, "materials", "candidates", `${safeName(id)}.json`), candidate);
  await appendEvent(projectDir, { type: "material_candidate", materialId: id, result: validation.passed ? "pass" : "fail", errors: validation.errors });
  return candidate;
}

export async function promoteMaterialCandidate(projectDir, materialId, evidence) {
  const candidatePath = path.join(projectDir, "materials", "candidates", `${safeName(materialId)}.json`);
  const candidate = await readJson(candidatePath);
  if (!candidate.validation?.passed || candidate.status === "rejected") throw new Error("material_candidate_not_validated");
  if (!evidence || !["user_review", "successful_answer"].includes(evidence.type)) throw new Error("promotion_requires_review_or_successful_answer");
  const promoted = {
    ...candidate,
    status: "promotion_queued",
    promotedAt: nowIso(),
    promotionEvidence: { type: evidence.type, note: normalizeText(evidence.note) }
  };
  await writeJson(path.join(projectDir, "remnote-promotion-queue", `${safeName(materialId)}.json`), promoted);
  candidate.status = "promotion_queued";
  candidate.promotedAt = promoted.promotedAt;
  await writeJson(candidatePath, candidate);
  await appendEvent(projectDir, { type: "material_promoted", materialId, evidence: promoted.promotionEvidence });
  return promoted;
}

export async function exportLearningProject(projectDir) {
  const rebuilt = await rebuildProject(projectDir);
  const events = await readEvents(projectDir);
  const materials = await listCandidateMaterials(projectDir);
  const bundle = {
    schema: "learning-project-export/v1",
    exportedAt: nowIso(),
    manifest: rebuilt.manifest,
    graph: rebuilt.graph,
    state: rebuilt.state,
    events,
    materials
  };
  const target = path.join(projectDir, "exports", `learning-project-${rebuilt.manifest.id}.json`);
  await writeJson(target, bundle);
  return { target, bundle };
}

async function readWindowsUserEnv(key) {
  if (process.platform !== "win32") return "";
  try {
    const result = await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      `[Environment]::GetEnvironmentVariable('${key}', 'User')`
    ], { timeoutMs: 10000 });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

async function readProducerMarkdownConfig() {
  const configFile = path.join(process.env.USERPROFILE || process.env.HOME || "", "Documents", "New project", "DeepSeek API 配置.md");
  try {
    const text = await fs.readFile(configFile, "utf8");
    const result = {};
    for (const line of text.split(/\r?\n/)) {
      const match = /^(AI_PRODUCER_[A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line.trim());
      if (match) result[match[1]] = match[2];
    }
    return result;
  } catch {
    return {};
  }
}

export async function loadLearningProducerConfig() {
  const keys = ["AI_PRODUCER_BASE_URL", "AI_PRODUCER_API_KEY", "AI_PRODUCER_MODEL"];
  const markdown = await readProducerMarkdownConfig();
  const config = {};
  for (const key of keys) config[key] = process.env[key] || await readWindowsUserEnv(key) || markdown[key] || "";
  const missing = keys.filter((key) => !config[key]);
  if (missing.length) throw new Error(`missing_learning_producer_config_${missing.join("_")}`);
  return config;
}

function producerUrl(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

function parseProducerJson(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return JSON.parse(cleaned);
}

export async function callLearningProducer({ system, user }) {
  const config = await loadLearningProducerConfig();
  const response = await fetch(producerUrl(config.AI_PRODUCER_BASE_URL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.AI_PRODUCER_API_KEY}`
    },
    body: JSON.stringify({
      model: config.AI_PRODUCER_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    }),
    signal: AbortSignal.timeout(120000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`learning_producer_http_${response.status}`);
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error("learning_producer_empty_response");
  return parseProducerJson(content);
}

async function sourceCorpus(projectDir, sourceFiles) {
  const manifest = await readJson(manifestPath(projectDir));
  const allowedRoots = [manifest.source.workspacePath, manifest.source.readingPackagePath]
    .filter(Boolean)
    .map((item) => path.resolve(item));
  const files = [];
  let total = 0;
  for (const sourceFile of sourceFiles || []) {
    const absolute = path.resolve(sourceFile);
    if (!allowedRoots.some((root) => absolute === root || absolute.startsWith(`${root}${path.sep}`))) {
      throw new Error("learning_source_outside_project_boundaries");
    }
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error("learning_source_must_be_file");
    const remaining = 60000 - total;
    if (remaining <= 0) break;
    const text = (await fs.readFile(absolute, "utf8")).slice(0, Math.min(20000, remaining));
    total += text.length;
    files.push({ path: absolute, text });
  }
  if (!files.length) throw new Error("learning_generation_requires_source_files");
  return files;
}

export async function generateGraphCandidate(projectDir, { sourceFiles, apply = false, producer = callLearningProducer } = {}) {
  const manifest = await readJson(manifestPath(projectDir));
  const corpus = await sourceCorpus(projectDir, sourceFiles);
  const response = await producer({
    system: [
      "You design a small prerequisite graph for learning a real open-source project.",
      "Return one JSON object with schema learning-concept-graph/v1, concepts, and tasks.",
      "Each concept needs id, title, prerequisites, order. Each task needs id, conceptId, type, title, activeRecall, verification.",
      "Keep 6-12 concepts. Prefer runnable outcomes, architecture tracing, debugging and one verified change.",
      "Do not claim facts absent from the supplied sources."
    ].join(" "),
    user: JSON.stringify({ goal: manifest.goal, repository: manifest.source.url, sources: corpus }, null, 2)
  });
  const graph = response.graph || response;
  let validation = { passed: true, errors: [] };
  try { validateGraph(graph); }
  catch (error) { validation = { passed: false, errors: [error.message] }; }
  const candidate = { schema: "learning-graph-candidate/v1", createdAt: nowIso(), sourceFiles: corpus.map((item) => item.path), validation, graph };
  await writeJson(path.join(projectDir, "concept-graph.candidate.json"), candidate);
  await appendEvent(projectDir, { type: "graph_candidate_generated", result: validation.passed ? "pass" : "fail", errors: validation.errors });
  if (apply) {
    if (!validation.passed) throw new Error("generated_graph_failed_validation");
    await replaceGraph(projectDir, graph);
  }
  return candidate;
}

export async function generateMaterialCandidates(projectDir, { sourceFiles, count = 6, producer = callLearningProducer } = {}) {
  const manifest = await readJson(manifestPath(projectDir));
  const graph = validateGraph(await readJson(graphPath(projectDir)));
  const corpus = await sourceCorpus(projectDir, sourceFiles);
  const boundedCount = Math.max(1, Math.min(12, Number(count) || 6));
  const response = await producer({
    system: [
      "Generate source-grounded learning materials for an open-source project.",
      `Return a JSON object with a materials array of at most ${boundedCount} items.`,
      "Each item needs kind flashcard or quiz, conceptId, objective, prompt, answer, sourcePointers with path and short excerpt.",
      "Quiz items may use format short_answer or multiple_choice; multiple choice needs at least two plausible distractors.",
      "Prioritize prediction, code-path tracing, debugging, trade-offs and transfer. Reject trivia and unsupported claims.",
      "Use only concept ids and source paths supplied by the user."
    ].join(" "),
    user: JSON.stringify({ goal: manifest.goal, concepts: graph.concepts, sources: corpus }, null, 2)
  });
  const proposed = Array.isArray(response.materials) ? response.materials.slice(0, boundedCount) : [];
  if (!proposed.length) throw new Error("learning_producer_returned_no_materials");
  const accepted = [];
  const rejected = [];
  for (const material of proposed) {
    const candidate = await addMaterialCandidate(projectDir, material);
    (candidate.validation.passed ? accepted : rejected).push(candidate);
  }
  const report = {
    schema: "learning-material-generation-report/v1",
    generatedAt: nowIso(),
    sourceFiles: corpus.map((item) => item.path),
    requested: boundedCount,
    proposed: proposed.length,
    accepted: accepted.map((item) => item.id),
    rejected: rejected.map((item) => ({ id: item.id, errors: item.validation.errors }))
  };
  await writeJson(path.join(projectDir, "materials", `generation-${report.generatedAt.replace(/[:.]/g, "-")}.json`), report);
  return { report, accepted, rejected };
}

export async function listLearningProjects(root = defaultLearningRoot) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readJson(path.join(root, entry.name, "manifest.json"), null);
    if (manifest) projects.push({ ...manifest, projectDir: path.join(root, entry.name) });
  }
  return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
