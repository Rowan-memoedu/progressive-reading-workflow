import {
  ChromeCookieJar,
  chromeCookieJarMatchingStatistics
} from "./chrome-cookie-jar.mjs";

const [snapshotPath] = process.argv.slice(2);
if (!snapshotPath) {
  process.stderr.write("usage: node scripts/check-cookie-snapshot-consumer.mjs <absolute-snapshot-path>\n");
  process.exit(2);
}

try {
  const jar = new ChromeCookieJar();
  const health = await jar.loadSnapshotFile(snapshotPath);
  const statistics = chromeCookieJarMatchingStatistics(jar);
  process.stdout.write(`${JSON.stringify({
    status: "loaded",
    source: health.source,
    source_schema: health.source_schema,
    source_schema_version: health.source_schema_version,
    snapshot_generated_at: health.snapshot_generated_at,
    snapshot_cookie_count: health.snapshot_cookie_count,
    accepted_cookie_count: health.cookie_count,
    skipped_count: health.skipped_count,
    skipped_partitioned_count: health.skipped_partitioned_count,
    skipped_expired_count: health.skipped_expired_count,
    domain_count: health.domain_count,
    matching_statistics: statistics,
    sensitive_values_exposed: false,
    snapshot_path_exposed: false
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`snapshot consumer validation failed: ${String(error?.message || "unknown_error")}\n`);
  process.exit(1);
}
