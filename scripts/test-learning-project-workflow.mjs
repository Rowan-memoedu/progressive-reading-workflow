import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addMaterialCandidate,
  createLearningProject,
  doctorLearningProject,
  exportLearningProject,
  generateGraphCandidate,
  generateMaterialCandidates,
  getProjectStatus,
  parseGithubRepoUrl,
  promoteMaterialCandidate,
  rebuildProject,
  recordLearningEvidence
} from "./learning-project-core.mjs";

async function main() {
  assert.deepEqual(parseGithubRepoUrl("https://github.com/example/demo"), {
    owner: "example",
    repo: "demo",
    url: "https://github.com/example/demo"
  });
  assert.throws(() => parseGithubRepoUrl("https://example.com/demo"), /repository_must_use_github_com/);
  assert.throws(() => parseGithubRepoUrl("https://github.com/example/demo/issues"), /github_repository_url_must_be_root/);

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "learning-project-test-"));
  try {
    const sourceDir = path.join(temp, "fixture-repo");
    const root = path.join(temp, "projects");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "package.json"), `${JSON.stringify({ name: "fixture", private: true }, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(sourceDir, "README.md"), "# Fixture\n\nA test repository.\n", "utf8");

    const created = await createLearningProject({
      repoUrl: "https://github.com/example/demo",
      goal: "完成真实验证",
      root,
      sourceDir
    });
    assert.equal(created.created, true);
    assert.equal(created.manifest.promotionPolicy, "candidate_first");

    const duplicateCreate = await createLearningProject({
      repoUrl: "https://github.com/example/demo",
      goal: "不覆盖既有项目",
      root,
      sourceDir
    });
    assert.equal(duplicateCreate.created, false);
    assert.equal(duplicateCreate.manifest.goal, "完成真实验证");

    const doctor = await doctorLearningProject(created.projectDir);
    assert.equal(doctor.workspaceExists, true);
    assert.deepEqual(doctor.signals.sort(), ["README.md", "package.json"]);
    assert.equal(doctor.status, "ready");

    let status = await getProjectStatus(created.projectDir);
    assert.equal(status.state.conceptStates.environment.status, "demonstrated");
    assert.equal(status.state.nextTask.id, "predict-repository-map");

    await recordLearningEvidence(created.projectDir, {
      conceptId: "repository-map",
      taskId: "predict-repository-map",
      result: "pass",
      verification: "verified",
      sourcePointer: "README.md#structure"
    });
    await recordLearningEvidence(created.projectDir, {
      conceptId: "repository-map",
      taskId: "predict-repository-map",
      result: "pass",
      verification: "self_report",
      note: "能独立复述"
    });
    status = await getProjectStatus(created.projectDir);
    assert.equal(status.state.conceptStates["repository-map"].status, "demonstrated");
    assert.equal(status.state.nextTask.id, "trace-execution-path");

    await recordLearningEvidence(created.projectDir, {
      conceptId: "verified-change",
      taskId: "make-verified-change",
      result: "fail",
      verification: "verified",
      sourcePointer: "test-output.txt"
    });
    status = await getProjectStatus(created.projectDir);
    assert.equal(status.state.nextTask.id, "trace-execution-path");
    assert.equal(status.state.nextReason, "remediate_prerequisite_for_verified-change");

    const material = await addMaterialCandidate(created.projectDir, {
      kind: "quiz",
      format: "multiple_choice",
      conceptId: "repository-map",
      objective: "区分入口层与服务层",
      prompt: "哪个文件定义了项目入口？",
      answer: "src/index.js",
      distractors: ["README.md", "package.json"],
      sourcePointers: [{ path: "src/index.js", excerpt: "main()" }]
    });
    assert.equal(material.validation.passed, true);
    assert.equal(material.status, "candidate");

    const duplicate = await addMaterialCandidate(created.projectDir, {
      kind: "quiz",
      conceptId: "repository-map",
      objective: "重复检查",
      prompt: "哪个文件定义了项目入口？",
      answer: "src/index.js",
      sourcePointers: [{ path: "src/index.js" }]
    });
    assert.equal(duplicate.validation.passed, false);
    assert.ok(duplicate.validation.errors.includes("duplicate_prompt"));

    const unsupported = await addMaterialCandidate(created.projectDir, {
      kind: "flashcard",
      conceptId: "repository-map",
      objective: "来源门禁",
      prompt: "无来源问题",
      answer: "不应晋级",
      sourcePointers: []
    });
    assert.equal(unsupported.validation.passed, false);
    await assert.rejects(() => promoteMaterialCandidate(created.projectDir, unsupported.id, { type: "user_review" }), /not_validated/);

    const promoted = await promoteMaterialCandidate(created.projectDir, material.id, {
      type: "successful_answer",
      note: "已实际作答并核对源码"
    });
    assert.equal(promoted.status, "promotion_queued");
    assert.equal(promoted.promotionEvidence.type, "successful_answer");

    const graphCandidate = await generateGraphCandidate(created.projectDir, {
      sourceFiles: [path.join(sourceDir, "README.md")],
      producer: async () => ({
        graph: {
          schema: "learning-concept-graph/v1",
          concepts: [{ id: "readme", title: "README 入口", prerequisites: [], order: 1 }],
          tasks: [{ id: "read-readme", conceptId: "readme", type: "trace", title: "解释 README", activeRecall: true, verification: "引用文件" }]
        }
      })
    });
    assert.equal(graphCandidate.validation.passed, true);
    status = await getProjectStatus(created.projectDir);
    assert.ok(status.graph.concepts.some((item) => item.id === "environment"));

    const generated = await generateMaterialCandidates(created.projectDir, {
      sourceFiles: [path.join(sourceDir, "README.md")],
      count: 2,
      producer: async () => ({
        materials: [{
          kind: "flashcard",
          conceptId: "repository-map",
          objective: "识别仓库用途",
          prompt: "这个测试仓库的直接用途是什么？",
          answer: "用于验证项目学习编排层。",
          sourcePointers: [{ path: path.join(sourceDir, "README.md"), excerpt: "A test repository." }]
        }]
      })
    });
    assert.equal(generated.accepted.length, 1);
    assert.equal(generated.rejected.length, 0);

    const exported = await exportLearningProject(created.projectDir);
    assert.ok(await fs.stat(exported.target));
    await fs.rm(path.join(created.projectDir, "state.json"));
    const rebuilt = await rebuildProject(created.projectDir);
    assert.equal(rebuilt.state.projectId, created.manifest.id);
    assert.ok(rebuilt.state.eventCount >= 10);

    process.stdout.write(`${JSON.stringify({ ok: true, projectId: created.manifest.id, eventCount: rebuilt.state.eventCount }, null, 2)}\n`);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
