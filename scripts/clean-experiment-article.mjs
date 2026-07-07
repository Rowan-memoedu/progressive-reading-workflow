import fs from "node:fs/promises";
import path from "node:path";

const workspaceRoot = path.resolve(process.cwd(), "../..");
const sourcePath = path.join(workspaceRoot, "download", "实验.md");
const outputDir = path.join(workspaceRoot, "download", "实验-清洗");
const outputPath = path.join(outputDir, "实验.cleaned.md");
const githubDir = path.join(outputDir, "github-repos");

const source = await fs.readFile(sourcePath, "utf8");
const githubUrls = [...new Set([...source.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?=https:\/\/github\.com\/|[^A-Za-z0-9_.-]|$)/g)].map(match => match[0]))];

function valueAfter(label) {
  const match = source.match(new RegExp(`^${label}：(.+)$`, "m"));
  return match?.[1]?.trim() || "";
}

function repoName(url) {
  return url.replace("https://github.com/", "");
}

function splitCollegeCodes(text) {
  const codes = [
    ["01", "哲学社会学院"],
    ["02", "文学院"],
    ["03", "外国语学院"],
    ["04", "艺术学院"],
    ["05", "体育学院"],
    ["06", "经济学院"],
    ["07", "法学院"],
    ["08", "行政学院"],
    ["09", "管理学院"],
    ["10", "数学学院"],
    ["11", "物理学院"],
    ["12", "化学学院"],
    ["13", "生命科学学院"],
    ["14", "机械与航空航天工程学院"],
    ["15", "汽车工程学院"],
    ["16", "材料科学与工程学院"],
    ["17", "交通学院"],
    ["18", "生物与农业工程学院"],
    ["19", "电子科学与工程学院"],
    ["20", "通信工程学院"],
    ["21", "计算机科学与技术学院"],
    ["22", "地球科学学院"],
    ["23", "地球探测科学与技术学院"],
    ["24", "建设工程学院"],
    ["25", "新能源与环境学院"],
    ["27", "公共卫生学院"],
    ["28", "药学院"],
    ["29", "护理学院"],
    ["33", "口腔医学院"],
    ["34", "商学院"],
    ["36", "公共外交学院"],
    ["37", "新闻与传播学院"],
    ["38", "考古学院"],
    ["39", "马克思主义学院"],
    ["40", "人工智能学院"],
    ["55", "软件学院"],
    ["65", "仪器科学与电气工程学院"],
    ["70", "临床医学院"],
    ["81", "动物医学学院"],
    ["82", "植物科学学院"],
    ["85", "动物科学学院"],
    ["87", "食品科学与工程学院"]
  ];

  let result = text.replace(
    /(学号起头两位\(首位补0\)对应专业\(学院\))/,
    "$1\n"
  );

  for (const [code, name] of codes) {
    const sourceCode = String(Number(code));
    result = result.replace(new RegExp(`(?<!\\d)${sourceCode}${name}`, "g"), `\n- ${code} ${name}`);
  }

  return result;
}

function normalizeBody(raw) {
  const bodyStart = raw.indexOf("谢邀");
  let body = bodyStart >= 0 ? raw.slice(bodyStart).trim() : raw.trim();

  if (githubUrls.length) {
    const first = body.indexOf(githubUrls[0]);
    const lastUrl = githubUrls[githubUrls.length - 1];
    const last = body.indexOf(lastUrl) + lastUrl.length;
    const resources = [
      "## GitHub 资源仓库",
      "",
      ...githubUrls.map(url => `- [${repoName(url)}](${url})`)
    ].join("\n");
    body = `${body.slice(0, first).trimEnd()}\n\n${resources}\n\n${body.slice(last).trimStart()}`;
  }

  body = body
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(?<!\n)(\d{1,2}\.\s+)/g, "\n\n$1")
    .replace(/(其他的我不知道,想到再更\.)/g, "$1\n\n")
    .replace(/(好我又找到了吉大一些非常冷的知识,更新一下\.\.\.)/g, "## 吉大冷知识更新\n\n$1\n\n")
    .replace(/(本科阶段该如何进行科研尝试-目标)/g, "### $1")
    .replace(/(来自同学的观点:)/g, "\n\n$1\n");

  body = splitCollegeCodes(body);

  return body
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(githubDir, { recursive: true });

const author = valueAfter("作者");
const sourceUrl = valueAfter("链接");
const sourceName = valueAfter("来源");
const now = new Date().toISOString();
const body = normalizeBody(source);

const cleaned = `---
source_file: "download/实验.md"
source_url: "${sourceUrl}"
source_author: "${author}"
source_name: "${sourceName}"
cleaned_at: "${now}"
status: cleaned
github_assets_dir: "download/实验-清洗/github-repos"
---

# 实验：知乎回答清洗版

> 作者：${author}
> 来源：${sourceName}
> 原链接：${sourceUrl}
> 说明：这里只做格式清洗、链接拆分和本地归档，不做事实核验，也不扩写原文。

${body}
`;

await fs.writeFile(outputPath, cleaned, "utf8");

console.log(JSON.stringify({
  outputPath,
  githubDir,
  githubUrls
}, null, 2));
