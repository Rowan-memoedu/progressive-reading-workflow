import assert from "node:assert/strict";
import test from "node:test";

import {
  compareProtectedUnits,
  extractTrinketFiles,
  protectedUnits,
  rewriteSourceMarkdown
} from "../scripts/import-cs-math-web-canary.mjs";

test("extractTrinketFiles decodes public embedded source", () => {
  const html = `<script>trinketObject = {"shortCode":"abc","lang":"python","name":"Demo","code":"[{&quot;name&quot;:&quot;main.py&quot;,&quot;content&quot;:&quot;print(&#39;ok&#39;)\\r\\n&quot;}]"};</script>`;
  const result = extractTrinketFiles(html);
  assert.equal(result.short_code, "abc");
  assert.deepEqual(result.files, [{ name: "main.py", content: "print('ok')\n" }]);
});

test("protectedUnits separates math, algorithms and inline code", () => {
  const markdown = [
    "Use $x+y$ and `run()`.",
    "",
    "$$",
    "x^2+y^2",
    "$$",
    "",
    "``` {.algorithm}",
    "return $x$",
    "```"
  ].join("\n");
  const units = protectedUnits(markdown);
  assert.equal(units.displayMath.length, 1);
  assert.equal(units.inlineMath.length, 1);
  assert.equal(units.inlineCode.length, 1);
  assert.equal(units.fenced.length, 1);
});

test("compareProtectedUnits rejects changed LaTeX or pseudocode", () => {
  const source = "Use $x+y$.\n\n``` {.algorithm}\nreturn x\n```";
  assert.equal(compareProtectedUnits(source, source).ok, true);
  assert.equal(compareProtectedUnits(source, source.replace("x+y", "x-y")).ok, false);
  assert.equal(compareProtectedUnits(source, source.replace("return x", "return y")).ok, false);
});

test("compareProtectedUnits can classify trailing code whitespace as non-breaking", () => {
  const source = "``` {.algorithm}\nreturn x  \n```";
  const candidate = "``` {.algorithm}\nreturn x\n```";
  const strict = compareProtectedUnits(source, candidate);
  const tolerant = compareProtectedUnits(source, candidate, { allowCodeWhitespaceNormalization: true });
  assert.equal(strict.ok, false);
  assert.equal(tolerant.ok, true);
  assert.equal(tolerant.exact_ok, false);
  assert.equal(tolerant.categories.fenced.whitespace_normalized.length, 1);
});

test("rewriteSourceMarkdown preserves protected units and localizes iframe", () => {
  const source = [
    "![figure](../figure/a.png)",
    "",
    "$$x^2$$",
    "",
    '<iframe src="https://trinket.io/embed/python/abc"></iframe>'
  ].join("\n");
  const rewritten = rewriteSourceMarkdown(source, "https://example.org/public/chapter.html", new Map([
    ["https://trinket.io/embed/python/abc", {
      label: "Demo",
      local_label: "main.py",
      local_path: "assets/trinket-abc/main.py"
    }]
  ]));
  assert.match(rewritten, /https:\/\/example\.org\/figure\/a\.png/u);
  assert.match(rewritten, /\]\(assets\/trinket-abc\/main\.py\)/u);
  assert.doesNotMatch(rewritten, /example\.org\/public\/assets\/trinket-abc/u);
  assert.equal(compareProtectedUnits(source, rewritten).ok, true);
});
