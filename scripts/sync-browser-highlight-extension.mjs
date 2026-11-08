import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowRoot = path.resolve(__dirname, "..");
const source = path.join(workflowRoot, "node_modules", "web-highlighter", "dist", "web-highlighter.min.js");
const targetDir = path.join(workflowRoot, "browser-highlight-extension", "lib");
const target = path.join(targetDir, "web-highlighter.min.js");

await fs.mkdir(targetDir, { recursive: true });
await fs.copyFile(source, target);
// The classic-script compatibility facade is generated from the same source
// consumed by Node and Obsidian. All extension loading paths use this file.
const facade = path.join(workflowRoot, "browser-highlight-extension", "draft-core.js");
const staging = `${facade}.tmp`;
await fs.copyFile(path.join(workflowRoot, "document-core", "core.js"), staging);
await fs.rename(staging, facade);
console.log(JSON.stringify({ copied: target }, null, 2));
