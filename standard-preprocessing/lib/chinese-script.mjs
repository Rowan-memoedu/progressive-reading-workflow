import OpenCC from "opencc-js";
import { protectTranslationMarkdown } from "./producer.mjs";

export const CHINESE_SCRIPT_POLICY_VERSION = "opencc-t2s-publication/v1";
const convert = OpenCC.Converter({ from: "t", to: "cn" });
export const simplifyChineseText = text => convert(String(text || ""));

// Publication is a display projection. Raw packages, model evidence and source
// hashes stay untouched; literal syntax and destinations must not be converted.
export function simplifyPublishedChinese(markdown) {
  const source = String(markdown || "");
  let changedCharacters = 0;
  const transform = (plain) => {
    const literalValues = [];
    const maskedLiterals = plain.replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|^ {0,3}\[[^\]\n]+\]:[\s\S]*?$/gmu, (value) => {
      const token = `ZXQSCRIPTLITERAL${literalValues.length}QXZ`;
      literalValues.push({ token, value });
      return token;
    });
    const wikiTargets = [];
    const maskedWiki = maskedLiterals.replace(/\[\[([^\]\n|]+)(\|[^\]\n]*)?\]\]/gu, (_match, target, label) => {
      if (!label && convert(target) === target) return _match;
      const token = `ZXQWIKITARGET${wikiTargets.length}QXZ`;
      wikiTargets.push({ token, value: target });
      // An unaliased wiki link receives a simplified display alias, while its
      // file/heading destination remains the literal original target.
      return `[[${token}|${label ? label.slice(1) : target}]]`;
    });
    const protectedValue = protectTranslationMarkdown(maskedWiki, { includeMath: true });
    let converted = convert(protectedValue.protectedMarkdown);
    const before = [...protectedValue.protectedMarkdown];
    const after = [...converted];
    changedCharacters += Math.max(before.length, after.length)
      ? before.filter((character, index) => character !== after[index]).length : 0;
    for (const item of [...protectedValue.values].reverse()) converted = converted.replaceAll(item.token, () => item.value);
    for (const item of wikiTargets) converted = converted.replaceAll(item.token, () => item.value);
    for (const item of literalValues) converted = converted.replaceAll(item.token, () => item.value);
    return converted;
  };
  const lines = source.split("\n");
  const output = [];
  let plain = [];
  let fence = null;
  let frontmatter = lines[0].replace(/\r$/u, "") === "---";
  const flush = () => {
    if (plain.length) output.push(transform(plain.join("\n")));
    plain = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (frontmatter) {
      output.push(/^(?:title|author|authors|description|summary|tags|keywords):/u.test(line) ? transform(line) : line);
      if (index > 0 && /^---\s*$/u.test(line)) frontmatter = false;
      continue;
    }
    if (fence) {
      output.push(line);
      if (new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`, "u").test(line)) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (opening) {
      flush();
      fence = { character: opening[1][0], length: opening[1].length };
      output.push(line);
    } else plain.push(line);
  }
  flush();
  return {
    markdown: output.join("\n"),
    report: {
      policy: CHINESE_SCRIPT_POLICY_VERSION,
      engine: "opencc-js",
      configuration: "t2s",
      changed_characters: changedCharacters,
      source_preserved_in_audit: true
    }
  };
}
