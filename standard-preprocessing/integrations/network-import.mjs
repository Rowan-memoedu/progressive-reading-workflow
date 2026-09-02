import {
  buildPreprocessRequest,
  runPreprocessingRequest,
  standardWorkflowOptions
} from "../index.mjs";

export async function preprocessNetworkMarkdown({
  markdown,
  sourceType,
  sourceMetadata,
  userInstruction = "",
  spoken = false,
  processingOptions = {},
  outputDir,
  publishPath,
  assetSourceDir,
  cacheDir,
  producer
}) {
  const preset = standardWorkflowOptions({
    ...(spoken ? { input_form: "spoken_transcript" } : {}),
    ...processingOptions
  });
  const request = buildPreprocessRequest({
    markdown,
    sourceType,
    sourceMetadata,
    userInstruction,
    processingOptions: preset
  });
  return runPreprocessingRequest(request, { outputDir, publishPath, assetSourceDir, cacheDir, producer });
}
