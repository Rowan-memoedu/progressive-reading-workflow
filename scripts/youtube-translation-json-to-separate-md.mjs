import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) {
    throw new Error(`Missing ${name}`);
  }
  return path.resolve(args[index + 1]);
}

const infoPath = readArg("--info");
const translationsPath = readArg("--translations-json");
const outPath = readArg("--out");

const info = JSON.parse((await fs.readFile(infoPath, "utf8")).replace(/^\uFEFF/, ""));
const items = JSON.parse((await fs.readFile(translationsPath, "utf8")).replace(/^\uFEFF/, ""));

const title = info.title || "YouTube Transcript";
const url = info.webpage_url || `https://www.youtube.com/watch?v=${info.id || ""}`;
const channel = info.channel || info.uploader || "";

const lines = [
  `# ${title}`,
  "",
  `- Source: ${url}`,
  `- Channel: ${channel}`,
  "",
  "## 中文正文",
  "",
];

for (const item of items) {
  if (item.zh?.trim()) {
    lines.push(item.zh.trim(), "");
  }
}

lines.push("## English Transcript", "");

for (const item of items) {
  if (item.en?.trim()) {
    lines.push(item.en.trim(), "");
  }
}

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${lines.join("\n").trimEnd()}\n`, "utf8");

console.log(JSON.stringify({
  outPath,
  items: items.length,
  chars: (await fs.readFile(outPath, "utf8")).length,
}, null, 2));
