import fs from "node:fs/promises";
import path from "node:path";

export async function saveZhihuBrowserCapture(targetPath, capture) {
  if (!targetPath || !Array.isArray(capture?.items) || capture.items.length === 0) {
    throw new Error("invalid_zhihu_browser_capture");
  }

  const seen = new Set();
  for (const item of capture.items) {
    if (!Number.isInteger(item?.index) || !item?.url || !item?.title || !item?.html) {
      throw new Error(`invalid_zhihu_browser_capture_item_${item?.index ?? "unknown"}`);
    }
    const itemKey = capture.layout === "column_folders"
      ? `${item.columnName || ""}\n${item.url}`
      : item.url;
    if (seen.has(itemKey)) throw new Error(`duplicate_zhihu_browser_capture_item_${itemKey}`);
    seen.add(itemKey);
  }

  const resolved = path.resolve(targetPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const tempPath = `${resolved}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, resolved);
  return {
    path: resolved,
    count: capture.items.length
  };
}

export async function saveJsonArtifact(targetPath, value) {
  const resolved = path.resolve(targetPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const tempPath = `${resolved}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, resolved);
  return resolved;
}
