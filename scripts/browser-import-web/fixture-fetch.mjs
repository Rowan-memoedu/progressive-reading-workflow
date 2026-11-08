// Test process preload only: every outbound request is served by a local fixture.
if (process.env.NODE_ENV !== "test" || !process.env.PROGRESSIVE_READING_FIXTURE_ORIGIN) throw new Error("fixture_fetch_test_environment_required");
const origin = new URL(process.env.PROGRESSIVE_READING_FIXTURE_ORIGIN);
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") throw new Error("fixture_fetch_loopback_required");
const nativeFetch = globalThis.fetch;
globalThis.fetch = (value, options = {}) => {
  const cookie = new Headers(options.headers).get("cookie");
  if (cookie && cookie !== "fixture_column_auth=synthetic-only") throw new Error("fixture_must_not_receive_real_cookies");
  const target = new URL("/fixture-fetch", origin);
  target.searchParams.set("url", String(value));
  return nativeFetch(target, options);
};
