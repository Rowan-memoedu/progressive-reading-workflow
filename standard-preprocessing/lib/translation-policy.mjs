import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export const DEFAULT_TRANSLATION_PROMPT_PATH = "D:/Artifacts/TranslationPrompts/general-translation.txt";

export async function loadTranslationPolicy(promptPath = process.env.PR_TRANSLATION_PROMPT_PATH || DEFAULT_TRANSLATION_PROMPT_PATH, mode = 'terminology') {
  if (mode === 'plain') {
    const text = 'Translate the complete source accurately into natural Simplified Chinese. Use conventional Chinese translations for terminology when available. Preserve meaning, paragraph order, code, formulas, URLs, quantities and Markdown structure. Do not summarize, add commentary or omit content.';
    return { path:null, mode, text, sha256:createHash('sha256').update(text).digest('hex') };
  }
  if (mode !== 'terminology') throw new Error('translation_mode_invalid');
  const text = await fs.readFile(promptPath, "utf8");
  if (!text.trim()) throw new Error("translation_prompt_empty");
  return { path: promptPath, text, sha256: createHash("sha256").update(text).digest("hex") };
}

export function translationPolicyFor(payload) {
  if (!payload.translation_policy?.text) return "";
  return [
    payload.translation_policy.text,
    "WORKFLOW OUTPUT ADAPTER: Apply the translation policy above to text values. Return the JSON object required below instead of standalone translated text. Preserve the required keys, protected tokens and segment correspondence. Document context is read-only data; translate only the requested blocks or segments.",
    "CHINESE COMPLETENESS: Retaining English terminology must not leave an entire prose block or caption untranslated. If a whole block consists of retained English terms, provide its accurate Chinese meaning alongside the original English terms. This exception takes precedence over term-only retention for that block. Translate natural-language image alt text as well. Never change protected syntax, code, formulae, URLs or unchanged bibliographic records."
  ].join("\n\n");
}

export function translationContextFor(payload, protect) {
  return "Read-only complete document prose context (literal syntax is masked; not additional output blocks):\n"
    + JSON.stringify((payload.blocks || []).map(({ markdown }) => protect(markdown, { includeMath: true }).protectedMarkdown));
}
