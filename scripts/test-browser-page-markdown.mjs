import test from "node:test";
import assert from "node:assert/strict";
import { htmlArticleToMarkdown } from "./browser-page-markdown.mjs";

const convert = content => htmlArticleToMarkdown({ sourceUrl: "https://example.org/lesson/intro", html: `<html><head><title>格式验收</title></head><body><article><h1>格式验收</h1><p>${"这是一篇包含数学、代码和引用的完整正文。".repeat(20)}</p>${content}</article></body></html>` });
test("explicit article body retains short link sections and excludes surrounding navigation", () => {
  const result = htmlArticleToMarkdown({ sourceUrl: "https://example.org/post", html: `<nav>Outside navigation</nav><article><header>Outside metadata</header><div itemprop="articleBody"><p>${"The research result is interesting. ".repeat(20)}</p><div><p>Further details:</p><ul><li><a href="/details">Technical write-up</a></li><li><a href="/code">Notebook</a></li></ul></div></div></article><footer>Outside footer</footer>` });
  assert.equal(result.method, "semantic_article_body");
  assert.ok(result.markdown.includes("Technical write-up"));
  assert.ok(result.markdown.includes("https://example.org/code"));
  assert.doesNotMatch(result.markdown, /Outside/);
});
test("microformat entry content preserves independent short material", () => {
  const result = htmlArticleToMarkdown({ sourceUrl: "https://other.example/entry", html: '<div class="h-entry"><h1>Metadata title</h1><section class="e-content"><p>A short complete note.</p><ul><li><a href="/reference">Reference</a></li></ul></section></div><aside>Related entries</aside>' });
  assert.equal(result.method, "semantic_article_body");
  assert.ok(result.markdown.includes("A short complete note."));
  assert.ok(result.markdown.includes("https://other.example/reference"));
  assert.doesNotMatch(result.markdown, /Metadata title|Related entries/);
});
test("KaTeX, MathJax and math images preserve one TeX expression each", () => {
  const result = convert(String.raw`<p>内联 <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi><mn>2</mn></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html">x2</span></span>。</p><div class="MathJax_Display" id="eq-Frame">ab</div><script id="eq" type="math/tex; mode=display">\frac{a}{b}</script><p>图片公式 <img class="ztext-math" alt="\sqrt{x}" src="/formula.svg"></p>`);
  assert.ok(result.markdown.includes("$x^2$"));
  assert.ok(result.markdown.includes("$$\n\\frac{a}{b}\n$$"));
  assert.ok(result.markdown.includes("$\\sqrt{x}$"));
  assert.equal(result.markdown.split("x^2").length - 1, 1);
  assert.equal(result.fidelity.formulas, 3);
  assert.doesNotMatch(result.markdown, /IRFORMULA|x2x|!\[\\sqrt/u);
});
test("independent native MathML, code, tables, links and images survive", () => {
  const result = convert('<p>原生公式 <math><mi>x</mi><mo>+</mo><mn>1</mn></math></p><pre><code class="language-js">const x = 2 &lt; 3;\nconsole.log(x);</code></pre><table><thead><tr><th>量</th><th>值</th></tr></thead><tbody><tr><td>a</td><td>2</td></tr></tbody></table><p><a href="../source">来源</a><img alt="图示" src="/figure.png"></p>');
  assert.match(result.markdown, /<math><mi>x<\/mi>/u);
  assert.ok(result.fidelity.warnings.includes("math_tex_unavailable_original_preserved"));
  assert.ok(result.markdown.includes("const x = 2 < 3;"));
  assert.ok(result.markdown.includes("```js\nconst x = 2 < 3;\nconsole.log(x);\n```"), "code language and newlines must survive article extraction");
  assert.match(result.markdown, /\| 量 \| 值 \|/u);
  assert.ok(result.markdown.includes("https://example.org/source"));
  assert.ok(result.markdown.includes("https://example.org/figure.png"));
});
test("short HTML keeps formatting instead of falling back to plain text", () => {
  const result = htmlArticleToMarkdown({sourceUrl:"https://example.org/", html:'<p>短公式 <math><semantics><mi>a</mi><annotation encoding="application/x-tex">a_1</annotation></semantics></math></p>'});
  assert.ok(result.markdown.includes("$a_1$"));
});
test("Chinese source math spans use source display mode and preserve TeX before Markdown escaping", () => {
  const result = convert(String.raw`<p>需求 <span class="ztext-math" data-eeimg="1" data-tex="K_q">K_q</span>。</p><p><span class="ztext-math" data-eeimg="2" data-tex=" C_q=\{c_{\mathrm{Go}},c_{\mathrm{Vue}}\}\\ ">C_q=\{c_{\mathrm{Go}},c_{\mathrm{Vue}}\}\\</span></p><p>已包裹 <span data-latex="$a_1$">a_1</span>。</p><pre><code>K_q = $host;</code></pre>`);
  assert.ok(result.markdown.includes("需求 $K_q$。"));
  assert.ok(result.markdown.includes(String.raw`$$
C_q=\{c_{\mathrm{Go}},c_{\mathrm{Vue}}\}\\
$$`));
  assert.ok(result.markdown.includes("已包裹 $a_1$。"));
  assert.ok(result.markdown.includes("K_q = $host;"));
  assert.equal(result.fidelity.formulas, 3);
  assert.doesNotMatch(result.markdown, /K\\_q|\\\\mathrm|\$\$a_1/u);
});
test("literal TeX delimiters survive Turndown escaping, while code stays literal", () => {
  const result = convert(String.raw`<p>原始表达式 \(a_1\) 和 $b_2$。</p><div>\[\frac{x_1}{y_2}\]</div><pre><code>print('$a_b$')</code></pre>`);
  assert.ok(result.markdown.includes("$a_1$"));
  assert.ok(result.markdown.includes("$b_2$"));
  assert.ok(result.markdown.includes("$$\n\\frac{x_1}{y_2}\n$$"));
  assert.ok(result.markdown.includes("print('$a_b$')"));
});
