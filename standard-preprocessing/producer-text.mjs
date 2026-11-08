import { loadProducerConfig, requestProducerText,producerBackend,producerModel } from './lib/producer.mjs';
import {CODEX_TRANSPORT_VERSION} from './lib/codex-exec.mjs';

// Private stdio bridge for the existing Python full-text validator.
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const config = await loadProducerConfig({requiredProvider:input.requiredProvider});
  const provider=producerBackend(config),model=producerModel(config);
  const identity=[provider,provider==='codex_exec'?'codex_exec':new URL(config.AI_PRODUCER_BASE_URL).hostname,model,
    ...(provider==='codex_exec'?[CODEX_TRANSPORT_VERSION]:[])];
  if(input.expectedIdentity&&JSON.stringify(input.expectedIdentity)!==JSON.stringify(identity))throw Error('producer_identity_changed');
  if(input.action==='identity')process.stdout.write(JSON.stringify({provider,model,identity,timeout_ms:config.AI_PRODUCER_TIMEOUT_MS}));
  else {
    const raw = await requestProducerText(config, input);
    process.stdout.write(JSON.stringify({...raw,provider,model,producer_identity:identity}));
  }
} catch(error) {
  // Only local route error codes are exposed, never provider diagnostics or credentials.
  const code=/^(?:producer_requires_\w+|producer_identity_changed|producer_visual_images_required|producer_images_require_codex_exec|producer_codex_routing_timeout)$/u.test(error.message)
    ? error.message:'reading_producer_text_failed';
  process.stderr.write(code+'\n');
  process.exitCode = 1;
}
