import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { randomUUID } from "node:crypto";

function cleanMathHtml(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll("script,style,iframe,object,embed").forEach(item => item.remove());
  for (const item of [clone, ...clone.querySelectorAll("*")]) {
    for (const attr of [...item.attributes]) {
      if (/^on/iu.test(attr.name) || /^(?:javascript|data:text\/html):/iu.test(attr.value)) item.removeAttribute(attr.name);
    }
  }
  return clone.outerHTML;
}

// Recover source expressions before Readability/Turndown discard annotations
// or duplicate the accessible and visual renderings of the same formula.
export function htmlArticleToMarkdown({ html, sourceUrl, title = "", extractArticle = true }) {
  const dom = new JSDOM(html, { url: sourceUrl });
  try {
    const doc = dom.window.document;
    doc.querySelectorAll("#local-ir-browser-toast,#local-ir-browser-workbench").forEach(node => node.remove());
    doc.querySelectorAll("mark.local-ir-browser-highlight").forEach(node => node.replaceWith(...node.childNodes));
    const prefix = `IRFORMULA${randomUUID().replaceAll("-", "")}X`;
    const formulas = new Map();
    const warnings = [];
    function protect(node, tex, display = false) {
      if (!node.isConnected) return;
      const token = `${prefix}${formulas.size}END`;
      let markdown;
      if (tex?.trim()) {
        let expression = tex.trim();
        if (/^\$\$[\s\S]*\$\$$/u.test(expression) || /^\\\[[\s\S]*\\\]$/u.test(expression)) {
          expression = expression.slice(2, -2).trim(); display = true;
        } else if (/^\$[^$][\s\S]*\$$/u.test(expression)) expression = expression.slice(1, -1);
        else if (/^\\\([\s\S]*\\\)$/u.test(expression)) expression = expression.slice(2, -2);
        markdown = display || expression.includes("\n") ? `\n\n$$\n${expression}\n$$\n\n` : `$${expression}$`;
      } else {
        const original = node.matches("math,svg,img") ? node : node.querySelector("math,svg,img");
        if (!original) throw new Error("math_source_unavailable:页面公式没有可保留的 TeX、MathML 或图像，请保留页面后重试。");
        markdown = cleanMathHtml(original);
        warnings.push("math_tex_unavailable_original_preserved");
      }
      const placeholder = doc.createElement(display ? "div" : "span");
      placeholder.textContent = token;
      node.replaceWith(placeholder);
      formulas.set(token, markdown);
    }
    for (const script of [...doc.querySelectorAll('script[type^="math/tex"]')]) {
      const display = /mode\s*=\s*display/iu.test(script.type);
      const frame = script.id && doc.getElementById(`${script.id}-Frame`);
      if (frame) (frame.closest(".MathJax_Display") || frame).remove();
      while (script.previousElementSibling?.matches(".MathJax,.MathJax_Display,.MathJax_Preview,mjx-container")) script.previousElementSibling.remove();
      protect(script, script.textContent, display);
    }
    const selectors = '.katex-display,.katex,mjx-container,.MathJax_Display,.MathJax,math,[data-tex],[data-latex],img.ztext-math,img[eeimg]';
    for (const node of [...doc.querySelectorAll(selectors)]) {
      if (!node.isConnected || node.closest("pre,code")) continue;
      const tex = node.getAttribute("data-tex") || node.getAttribute("data-latex")
        || node.querySelector('annotation[encoding="application/x-tex"]')?.textContent
        || (node.matches("img.ztext-math,img[eeimg]") ? node.getAttribute("alt") : null);
      const display = node.matches('.katex-display,.MathJax_Display,[display="block"],[display="true"]')
        // Zhihu's source HTML marks inline math as 1 and display math as 2.
        // Read this before Readability removes source-only attributes.
        || node.matches('[data-eeimg="2"],[eeimg="2"]')
        || node.querySelector('math[display="block"]') !== null;
      protect(node, tex, display);
    }
    const walker = doc.createTreeWalker(doc.body, dom.window.NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) {
      if (node.parentElement?.closest("pre,code,script,style")) continue;
      const pattern = /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$\$[\s\S]*?\$\$|(?<!\\)\$(?!\$)(?:\\.|[^$\n])+(?<!\\)\$/gu;
      const matches = [...node.textContent.matchAll(pattern)];
      if (!matches.length) continue;
      const fragment = doc.createDocumentFragment();
      let start = 0;
      for (const match of matches) {
        fragment.append(doc.createTextNode(node.textContent.slice(start, match.index)));
        const token = `${prefix}${formulas.size}END`;
        let expression = match[0];
        if (expression.startsWith("\\[")) expression = `\n\n$$\n${expression.slice(2,-2)}\n$$\n\n`;
        else if (expression.startsWith("\\(")) expression = `$${expression.slice(2,-2)}$`;
        formulas.set(token, expression);
        fragment.append(doc.createTextNode(token));
        start = match.index + match[0].length;
      }
      fragment.append(doc.createTextNode(node.textContent.slice(start)));
      node.replaceWith(fragment);
    }
    // Freeze these sources before Readability mutates its input document.
    doc.querySelectorAll("script,style,noscript,iframe,object,embed").forEach(node => node.remove());
    for (const node of doc.querySelectorAll("a[href],img[src]")) {
      const attr = node.tagName === "A" ? "href" : "src";
      try { node.setAttribute(attr, new URL(node.getAttribute(attr), sourceUrl).href); } catch { /* Preserve original. */ }
    }
    const explicitBodies = extractArticle ? doc.querySelectorAll('[itemprop~="articleBody"], .h-entry .e-content') : [];
    const explicitBody = explicitBodies.length === 1 ? explicitBodies[0] : null;
    const fallback = (extractArticle ? explicitBody || doc.querySelector("article,main,[role=main]") || doc.body : doc.body).innerHTML;
    // Turndown uses language-* classes to preserve fenced-code languages.
    const article = extractArticle && !explicitBody ? new Readability(doc, { keepClasses: true }).parse() : null;
    const converter = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
    converter.use(gfm);
    const content = article?.content || fallback;
    let markdown = converter.turndown(content).trim();
    let preserved = 0;
    for (const [token, formula] of formulas) {
      if (!markdown.includes(token)) continue; // Formulas outside the selected article are not article content.
      preserved += 1;
      markdown = markdown.split(token).join(formula);
    }
    if (!markdown) throw new Error("empty_page_content");
    return { method: explicitBody ? "semantic_article_body" : article?.content ? "readability_html" : "body_html", title: article?.title || title,
      byline:article?.byline || '',excerpt:article?.excerpt || '',
      markdown, fidelity: { formulas: preserved, warnings: [...new Set(warnings)] } };
  } finally { dom.window.close(); }
}
