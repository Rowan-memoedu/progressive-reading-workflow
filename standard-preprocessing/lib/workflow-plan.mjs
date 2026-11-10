// One policy for every standard-workflow entry point. Missing is distinct from false.
export const WORKFLOW_PLAN_VERSION = "processing-plan/v2";
export const ROUTE_VALUES = Object.freeze({
  input_form: ["written", "spoken_transcript"],
  content_profile: ["natural_language", "math_lecture", "literature"],
  source_language: ["zh", "en", "bilingual", "other"]
});
export const PROCESSING_CHOICES = ["spoken_to_written", "structure_body", "translate", "include_reading_guide"];

export function requiredRouteLabels(options, labels) {
  const needed = new Set();
  if (options.spoken_to_written === undefined && options.structure_body !== true) needed.add("input_form");
  if (options.translate === undefined) needed.add("source_language");
  if (options.include_reading_guide === undefined) needed.add("content_profile");
  // An explicitly selected operation does not require another type decision.
  // Available profiles still select a specialized implementation; otherwise use the general path.
  return [...needed].filter(key => !labels[key]);
}

export function resolveProcessingPlan(options, labels) {
  const defaults = {
    spoken_to_written: labels.input_form === "spoken_transcript",
    structure_body: false,
    translate: labels.source_language === "en" || labels.source_language === "other",
    include_reading_guide: labels.content_profile === "natural_language"
  };
  return {
    version: WORKFLOW_PLAN_VERSION,
    choices: Object.fromEntries(PROCESSING_CHOICES.map(key => [key, {
      enabled: options[key] ?? defaults[key],
      source: options[key] !== undefined ? "explicit_request" : "type_default"
    }])),
    body_mode: options.structure_body === true ? "strong_structuring"
      : (options.spoken_to_written ?? defaults.spoken_to_written) ? "spoken_to_written" : "preserve",
    translation_target_language: options.translation_target_language || "zh-CN"
  };
}
