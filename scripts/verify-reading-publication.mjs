import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import OpenCC from "opencc-js";
import { unwrapPublishedOriginal } from "../standard-preprocessing/lib/original-section.mjs";
import { simplifyPublishedChinese } from "../standard-preprocessing/lib/chinese-script.mjs";

const [runArgument, packageArgument] = process.argv.slice(2);
if (!runArgument || !packageArgument) throw new Error("usage: node scripts/verify-reading-publication.mjs <run-dir> <source-package-dir>");
const run = path.resolve(runArgument);
const sourcePackage = path.resolve(packageArgument);
const readJson = async file => JSON.parse(await fs.readFile(file, "utf8"));
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const convert = OpenCC.Converter({ from: "t", to: "cn" });
const visibleText = text => convert(text
  .replace(/<!--[\s\S]*?-->/gu, "")
  .replace(/<[^>]+>/gu, "")
  .replace(/(!?\[[^\]\n]*\])\([^\n]*?\)/gu, "$1")
  .replace(/[^\p{L}\p{N}]/gu, ""));
const result = await readJson(path.join(run, "result.json"));
const request = await readJson(path.join(run, "request.json"));
const publication = await readJson(path.join(run, "publication.json"));
const manifest = await readJson(path.join(sourcePackage, "manifest.json"));
for (const file of manifest.files) {
  assert.equal(hash(await fs.readFile(path.join(sourcePackage, file.path))), file.sha256, `source package changed: ${file.path}`);
}
const markdown = await fs.readFile(publication.markdown.path, "utf8");
assert.equal(hash(markdown), publication.markdown.sha256, "published hash mismatch");
assert.equal(result.translation_state, "generated_translation", "requested translation was not generated");
assert.equal(result.receipt.reading_guide.status, "generated", "requested guide was not generated");
assert.equal(publication.status, "published");
assert.equal(publication.cleanliness.valid, true);
assert.deepEqual(publication.failed_validations, []);
assert.equal(simplifyPublishedChinese(markdown).markdown, markdown, "readable traditional characters remain");
const original = unwrapPublishedOriginal(markdown.split("\n## 原文\n")[1]);
assert.ok(original, "original section is missing");
assert.equal(visibleText(original), visibleText(request.material.markdown), "original visible text coverage mismatch");
assert.equal(visibleText(request.material.markdown), visibleText(await fs.readFile(path.join(sourcePackage, "raw.md"), "utf8")));
const targets = [...markdown.matchAll(/\[\[#\^([^|\]]+)\|[^\]]*\]\]/gu)].map(match => match[1]);
for (const target of targets) assert.match(markdown, new RegExp(`^\\^${target}$`, "mu"), `broken jump: ${target}`);
const imageTargets = [...markdown.matchAll(/!\[[^\]\n]*\]\(([^\n)]+)\)/gu)].map(match => match[1]);
for (const target of imageTargets) {
  if (/^https?:/u.test(target)) continue;
  const image = await fs.readFile(path.resolve(path.dirname(publication.markdown.path), decodeURI(target)));
  assert.ok(image.length > 0, `empty image: ${target}`);
}
for (const asset of publication.assets) {
  const assetPath = asset.published_path || asset.path;
  assert.equal(hash(await fs.readFile(assetPath)), asset.sha256);
}
const publishedAssetHashes = new Set(publication.assets.map(asset => asset.sha256));
for (const asset of manifest.assets) assert.ok(publishedAssetHashes.has(asset.sha256), `source image asset missing: ${asset.filename}`);
const report = {
  passed: true, source_package: sourcePackage, source_sha256: manifest.source.sha256,
  source_pages: request.source_metadata.page_count, original_visible_text_complete: true,
  raw_package_unchanged: true, translation: result.translation_state,
  guide: result.receipt.reading_guide.status, model_calls: result.receipt.model.calls,
  reading_path: publication.markdown.path, reading_bytes: publication.markdown.bytes,
  reading_sha256: publication.markdown.sha256, source_image_assets: manifest.assets.length,
  image_references: imageTargets.length, jump_references: targets.length,
  chinese_script: publication.chinese_script, readable_traditional_characters_remaining: false,
  quality: publication.quality_status
};
await fs.writeFile(path.join(run, "independent-publication-validation.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
