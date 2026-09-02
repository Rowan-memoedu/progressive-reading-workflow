import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { compareProtectedUnits } from "./import-cs-math-web-canary.mjs";

function parseArgs(argv) {
  const index = argv.indexOf("--run");
  if (index === -1 || !argv[index + 1]) throw new Error("missing_run_directory");
  return { run: path.resolve(argv[index + 1]) };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function main() {
  const { run } = parseArgs(process.argv.slice(2));
  const source = await fs.readFile(path.join(run, "source.md"), "utf8");
  const readingPath = path.join(run, "preprocess-shadow", "reading.md");
  const reading = await fs.readFile(readingPath, "utf8");
  const result = await readJson(path.join(run, "preprocess-shadow", "result.json"));
  const capture = await readJson(path.join(run, "capture-receipt.json"));
  const shadowAssetCopies = [];
  for (const asset of capture.artifacts?.embedded_assets || []) {
    for (const file of asset.files || []) {
      const relativePath = String(file.path || "").replace(/\\/gu, "/");
      if (!relativePath.startsWith("assets/")) continue;
      const sourcePath = path.join(run, ...relativePath.split("/"));
      const shadowPath = path.join(run, "preprocess-shadow", ...relativePath.split("/"));
      await fs.mkdir(path.dirname(shadowPath), { recursive: true });
      await fs.copyFile(sourcePath, shadowPath);
      shadowAssetCopies.push(path.relative(run, shadowPath).replace(/\\/gu, "/"));
    }
  }
  const protectedValidation = compareProtectedUnits(source, reading, { allowCodeWhitespaceNormalization: true });
  const bodyBlocks = result.artifacts?.body_blocks || [];
  const unchangedBlocks = bodyBlocks.filter((block) => block.source_hash === block.output_hash).length;
  const generatedTimestampMatches = reading.match(/^(?:imported_at|created_at|processed_at):|^#{1,6}\s+\d{1,2}:\d{2}/gmu) || [];
  const perspectiveShiftMatches = reading.match(/作者(?:认为|指出|表示)/gu) || [];

  const codeAsset = capture.artifacts?.embedded_assets?.[0]?.primary_path || "";
  const codePath = codeAsset ? path.join(run, ...codeAsset.split("/")) : "";
  const codeRun = codePath
    ? spawnSync("python", [codePath], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
      })
    : { status: null, stdout: "", stderr: "code_asset_missing" };
  const codeOk = codeRun.status === 0;
  const safetyChecksOk = protectedValidation.ok
    && bodyBlocks.length > 0
    && unchangedBlocks === bodyBlocks.length
    && generatedTimestampMatches.length === 0
    && perspectiveShiftMatches.length === 0
    && codeOk;
  const status = safetyChecksOk
    ? (result.status === "completed" ? "completed" : "completed_with_warnings")
    : "failed";
  const receipt = {
    status,
    artifacts: {
      raw_markdown: capture.artifacts.raw_markdown,
      source_markdown: "source.md",
      reading_candidate: "preprocess-shadow/reading.md",
      preprocess_result: "preprocess-shadow/result.json",
      source_metadata: "source-metadata.json",
      embedded_assets: capture.artifacts.embedded_assets,
      alternate_pdf: capture.artifacts.alternate_pdf
    },
    source_metadata: capture.source_metadata,
    receipt: {
      promotion: status === "completed" ? "candidate" : status === "completed_with_warnings" ? "review_required" : "blocked",
      preprocess_status: result.status,
      preprocess_state: result.processing_state,
      model_calls: result.receipt?.model?.calls ?? 0,
      body_blocks: {
        total: bodyBlocks.length,
        unchanged: unchangedBlocks
      },
      protected_units: protectedValidation,
      generated_timestamps: generatedTimestampMatches,
      third_person_reframing_markers: perspectiveShiftMatches,
      local_code: {
        path: codeAsset || null,
        exit_code: codeRun.status,
        stdout: String(codeRun.stdout || "").trim(),
        stderr: String(codeRun.stderr || "").trim()
      },
      shadow_asset_copies: shadowAssetCopies
    },
    gaps: [
      {
        code: "full_text_translation_not_supported_by_preprocess_v1",
        impact: "本轮保留英文正文，只验证了术语与 LaTeX/代码保真边界，未生成中文全文译文。"
      }
    ],
    errors: [...(result.errors || [])]
  };
  await fs.writeFile(path.join(run, "canary-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    status,
    promotion: receipt.receipt.promotion,
    protected_units_ok: protectedValidation.ok,
    unchanged_blocks: `${unchangedBlocks}/${bodyBlocks.length}`,
    local_code_ok: codeOk,
    preprocess_status: result.status
  }));
  if (status === "failed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
