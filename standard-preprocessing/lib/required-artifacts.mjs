// Publication checks generation, not prose style or a per-block language score.
export function requiredArtifactFailures(result) {
  const receipt = result?.receipt || {};
  const choices = receipt.workflow_route?.plan?.choices;
  const policy = receipt.cleaning_policy;
  const validations = new Map((receipt.validations || []).map(item => [item.name, item.status]));
  const requireTranslation = choices?.translate?.enabled ?? (policy?.mode === "source_translation");
  const requireGuide = choices?.include_reading_guide?.enabled ?? (policy ? policy.include_reading_guide !== false : false);
  const failures = [];
  if (requireTranslation) {
    const translatedStage = receipt.workflow_route?.stages?.find(item => item.id === "profile_translation");
    if (result?.translation_state !== "generated_translation"
      || validations.get("source_translation") === "failed"
      || (translatedStage && translatedStage.processing_state !== "rendered")
      || !result?.artifacts?.body_blocks?.some(block => String(block.markdown || "").trim())) {
      failures.push("required_translation_missing");
    }
  }
  if (requireGuide) {
    const judgments = result?.artifacts?.semantic?.judgments;
    if (!judgments || !["value", "density", "continue_reading"].every(key => String(judgments[key]?.reason || "").trim())
      || receipt.reading_guide?.status === "failed"
      || validations.get("reading_guide_plan") === "failed") {
      failures.push("required_reading_guide_missing");
    }
  }
  return failures;
}
