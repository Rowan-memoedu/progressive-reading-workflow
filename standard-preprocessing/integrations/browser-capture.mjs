import { buildPreprocessRequest, runPreprocessingRequest, standardWorkflowOptions } from "../index.mjs";

export function browserCaptureProcessingOptions(action, overrides = {}) {
  if (!['save', 'import'].includes(action)) throw new Error('unsupported_browser_capture_action');
  return action === 'save'
    ? { ...overrides, spoken_to_written: false, structure_body: false, translate: false, include_reading_guide: false }
    : { ...overrides, include_reading_guide: true };
}

export async function preprocessBrowserCapture({
  markdown, sourceMetadata, userInstruction = "", processingOptions = {},
  outputDir, publishPath, assetSourceDir, cacheDir, producer, onProgress
}) {
  const request = buildPreprocessRequest({
    markdown,
    sourceType: "browser_capture_markdown",
    sourceMetadata: { input_form: "written", ...sourceMetadata },
    userInstruction,
    processingOptions: standardWorkflowOptions(processingOptions)
  });
  // Stage processors own bounded retries. Re-running the workflow here multiplies calls.
  const run = await runPreprocessingRequest(request, { outputDir, publishPath, assetSourceDir, cacheDir, producer, onProgress });
  return {
    ...run,
    workflow_attempts: [{
      attempt: 1, status: run.result.status, processing_state: run.result.processing_state,
      target_zone: run.result.artifacts?.target_zone || null,
      model_calls: run.result.receipt?.model?.calls || 0
    }]
  };
}
