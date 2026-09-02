import {
  buildPreprocessRequest,
  runPreprocessingRequest,
  isReadyResult,
  standardWorkflowOptions
} from "../index.mjs";

const DEFAULT_BROWSER_PREPROCESS_ATTEMPTS = 3;

function retryableReviewResult(result) {
  return Boolean(
    result
    && (
      result.status === "completed_with_warnings"
      || (
        result.status === "idempotent_replay"
        && result.receipt?.replay_of_status === "completed_with_warnings"
      )
    )
    && result.processing_state === "degraded"
    && result.artifacts?.target_zone === "preprocess-review"
  );
}

export async function preprocessBrowserCapture({
  markdown,
  sourceMetadata,
  userInstruction = "",
  processingOptions = {},
  outputDir,
  publishPath,
  assetSourceDir,
  cacheDir,
  producer,
  maxAttempts = DEFAULT_BROWSER_PREPROCESS_ATTEMPTS
}) {
  const request = buildPreprocessRequest({
    markdown,
    sourceType: "browser_capture_markdown",
    sourceMetadata,
    userInstruction,
    processingOptions: standardWorkflowOptions({
      input_form: "written",
      ...processingOptions
    })
  });
  const boundedAttempts = Math.max(1, Math.min(3, Number(maxAttempts) || DEFAULT_BROWSER_PREPROCESS_ATTEMPTS));
  const workflowAttempts = [];
  let latestRun = null;
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    latestRun = await runPreprocessingRequest(request, {
      outputDir,
      publishPath,
      assetSourceDir,
      cacheDir,
      producer,
      skipCacheRead: attempt > 1
    });
    workflowAttempts.push({
      attempt,
      status: latestRun.result?.status || "unknown",
      processing_state: latestRun.result?.processing_state || "unknown",
      target_zone: latestRun.result?.artifacts?.target_zone || "unknown",
      model_calls: Number(latestRun.result?.receipt?.model?.calls || 0)
    });
    if (isReadyResult(latestRun.result) || !retryableReviewResult(latestRun.result)) break;
  }
  return { ...latestRun, workflow_attempts: workflowAttempts };
}
