import fs from "node:fs/promises";

import { normalizeUrl } from "./core.mjs";

export const SUBSCRIPTIONS_SCHEMA = "progressive-reading.rss-subscriptions/v1";

function requirePlainObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value;
}

function normalizeSubscription(value, index) {
  const item = requirePlainObject(value, `subscription_${index}_must_be_object`);
  const id = String(item.id || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/u.test(id)) throw new Error(`subscription_${index}_invalid_id`);
  if (!item.feed_url) throw new Error(`subscription_${id}_feed_url_required`);
  const feedUrl = normalizeUrl(item.feed_url);
  let siteUrl = null;
  if (item.site_url) siteUrl = normalizeUrl(item.site_url);
  if (item.enabled != null && typeof item.enabled !== "boolean") throw new Error(`subscription_${id}_enabled_must_be_boolean`);
  if (item.fetch_fulltext != null && typeof item.fetch_fulltext !== "boolean") {
    throw new Error(`subscription_${id}_fetch_fulltext_must_be_boolean`);
  }
  if (item.user_instruction != null && typeof item.user_instruction !== "string") {
    throw new Error(`subscription_${id}_user_instruction_must_be_string`);
  }
  return {
    id,
    display_name: String(item.display_name || id).trim(),
    enabled: item.enabled !== false,
    feed_url: feedUrl,
    site_url: siteUrl,
    fetch_fulltext: item.fetch_fulltext === true,
    user_instruction: String(item.user_instruction || "")
  };
}

export function validateSubscriptionRegistry(value) {
  const registry = requirePlainObject(value, "subscription_registry_must_be_object");
  if (registry.schema_version !== SUBSCRIPTIONS_SCHEMA) throw new Error("unsupported_subscription_registry_schema");
  if (!Array.isArray(registry.subscriptions)) throw new Error("subscriptions_must_be_array");
  const subscriptions = registry.subscriptions.map(normalizeSubscription);
  const ids = new Set();
  const feedUrls = new Set();
  for (const subscription of subscriptions) {
    if (ids.has(subscription.id)) throw new Error(`duplicate_subscription_id_${subscription.id}`);
    if (feedUrls.has(subscription.feed_url)) throw new Error(`duplicate_subscription_feed_url_${subscription.feed_url}`);
    ids.add(subscription.id);
    feedUrls.add(subscription.feed_url);
  }
  return {
    schema_version: SUBSCRIPTIONS_SCHEMA,
    registry_version: String(registry.registry_version || "1.0.0"),
    subscriptions
  };
}

export async function loadSubscriptionRegistry(filePath) {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  return validateSubscriptionRegistry(parsed);
}

export function subscriptionRegistryResult(registry, configPath) {
  const enabled = registry.subscriptions.filter((item) => item.enabled);
  return {
    schema_version: "progressive-reading.rss-subscription-list/v1",
    status: "valid",
    config_path: configPath,
    subscription_count: registry.subscriptions.length,
    enabled_count: enabled.length,
    subscriptions: registry.subscriptions
  };
}

export async function runSubscriptionBatch({ registry, options = {}, syncOne, batchId }) {
  if (typeof syncOne !== "function") throw new Error("subscription_batch_sync_function_required");
  const requestedId = String(options["subscription-id"] || "").trim();
  const selected = registry.subscriptions.filter((item) => item.enabled && (!requestedId || item.id === requestedId));
  if (requestedId && selected.length === 0) throw new Error(`enabled_subscription_not_found_${requestedId}`);
  const results = [];
  for (const subscription of selected) {
    try {
      const result = await syncOne(subscription, {
        ...options,
        "feed-url": subscription.feed_url,
        "user-instruction": options["user-instruction"] ?? subscription.user_instruction,
        "fetch-fulltext": options["fetch-fulltext"] === true || subscription.fetch_fulltext
      });
      results.push({ subscription_id: subscription.id, display_name: subscription.display_name, ok: true, result });
    } catch (error) {
      results.push({
        subscription_id: subscription.id,
        display_name: subscription.display_name,
        ok: false,
        error: { code: "subscription_sync_failed", message: error.message }
      });
    }
  }
  const failures = results.filter((item) => !item.ok).length;
  const degraded = results.filter((item) => item.ok && item.result?.status === "completed_with_failures").length;
  return {
    schema_version: "progressive-reading.rss-subscription-batch/v1",
    status: failures || degraded ? "completed_with_failures" : "completed",
    batch_id: batchId,
    subscription_count: selected.length,
    succeeded: selected.length - failures,
    failed: failures,
    degraded,
    results,
    writes: { reading_area: false, remnote: false, logseq: false, browser: false }
  };
}
