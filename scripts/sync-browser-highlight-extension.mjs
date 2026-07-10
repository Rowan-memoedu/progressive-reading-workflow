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
console.log(JSON.stringify({ copied: target }, null, 2));
