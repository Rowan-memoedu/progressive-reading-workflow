import fs from "node:fs/promises";
import path from "node:path";

export const IMPORT_DESTINATION_ROUTES_SCHEMA = "progressive-reading.import-destination-routes/v1";

export async function loadImportDestinationRoutes(configPath) {
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (parsed?.schema !== IMPORT_DESTINATION_ROUTES_SCHEMA || !parsed.routes?.default) {
    throw new Error("import_destination_routes_invalid");
  }
  return parsed;
}

export function normalizeRelativeDestinationFolder(value, { required = false } = {}) {
  const raw = String(value || "").trim().replaceAll("\\", "/");
  if (!raw) {
    if (required) throw new Error("destination_folder_required");
    return "";
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/u.test(raw)) throw new Error("destination_folder_must_be_relative");
  const segments = raw.split("/").filter(Boolean);
  if (!segments.length || segments.some((item) => item === "." || item === ".." || /[<>:"\\|?*\u0000-\u001f]/u.test(item))) {
    throw new Error("destination_folder_invalid");
  }
  return segments.join("/");
}

export function inferImportEntryRoute(source, explicitRoute = "") {
  const explicit = String(explicitRoute || "").trim();
  if (explicit) return explicit;
  const value = String(source || "").toLowerCase();
  if (value.includes("browser")) return "browser_extension";
  if (value.includes("obsidian")) return "obsidian";
  if (value.includes("archive-social-reading") || value.includes("ai")) return "ai";
  return "default";
}

export function resolveImportDestinationFolder(routesConfig, {
  source,
  entryRoute,
  destinationFolder,
  sourceUrl
}) {
  const routeName = inferImportEntryRoute(source, entryRoute);
  const route = routesConfig.routes[routeName] || routesConfig.routes.default;
  const explicit = normalizeRelativeDestinationFolder(destinationFolder);
  if (explicit) return explicit;
  if (route.mode === "fixed") return normalizeRelativeDestinationFolder(route.folder, { required: true });
  if (route.mode === "domain") {
    const hostname = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./u, "");
    return normalizeRelativeDestinationFolder(hostname, { required: true });
  }
  if (route.mode === "explicit") throw new Error(`destination_folder_required_for_${routeName}`);
  throw new Error(`unsupported_import_destination_mode_${route.mode || "unknown"}`);
}

export function resolveReadingDestinationRoot(readingRoot, folder) {
  const normalized = normalizeRelativeDestinationFolder(folder, { required: true });
  const root = path.resolve(readingRoot, ...normalized.split("/"));
  const readingPrefix = `${path.resolve(readingRoot)}${path.sep}`;
  if (!root.startsWith(readingPrefix)) throw new Error("destination_folder_outside_reading_root");
  return root;
}
