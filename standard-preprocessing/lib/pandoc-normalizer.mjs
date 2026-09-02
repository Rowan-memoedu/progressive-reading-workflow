function trimOuter(value) {
  return String(value || "").replace(/^(?:\s*\n)+|(?:\n\s*)+$/gu, "");
}

function attributes(raw = "") {
  const title = /\btitle\s*=\s*"([^"]*)"/u.exec(raw)?.[1] || "";
  const id = /(?:^|\s)#([A-Za-z0-9_:-]+)/u.exec(raw)?.[1] || "";
  const classes = [...raw.matchAll(/(?:^|\s)\.([A-Za-z0-9_+-]+)/gu)].map((match) => match[1]);
  const data = Object.fromEntries([...raw.matchAll(/\b(data-[A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/gu)].map((match) => [match[1], match[2]]));
  return { title, id, classes, data, raw: raw.trim() };
}

function semanticLabel(kind, title = "", exerciseNumber = null) {
  if (kind === "algorithm") return `### Algorithm${title ? `: ${title}` : ""}`;
  if (kind === "exercise") return `## Exercise${exerciseNumber ? ` ${exerciseNumber}` : ""}${title ? `: ${title}` : ""}`;
  if (kind === "proof") return "### Proof";
  if (kind === "remark") return `### Remark${title ? `: ${title}` : ""}`;
  if (kind === "objectives") return "### Learning objectives";
  if (kind === "lemma") return `### Lemma${title ? `: ${title}` : ""}`;
  return `### Note${title ? `: ${title}` : ""}`;
}

function normalizeAlgorithmBody(body) {
  const lines = String(body || "").replace(/\r\n?/gu, "\n").split("\n");
  const output = [];
  const steps = [];
  let input = "";
  let result = "";
  let procedure = "";
  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+$/u, "");
    if (!line.trim()) continue;
    const inputMatch = /^\s*INPUT\s*:\s*(.*)$/iu.exec(line);
    if (inputMatch) { input = inputMatch[1].trim(); continue; }
    const outputMatch = /^\s*OUTPUT\s*:\s*(.*)$/iu.exec(line);
    if (outputMatch) { result = outputMatch[1].trim(); continue; }
    const procedureMatch = /^\s*procedure\{([^}]*)\}\{([^}]*)\}\s*$/iu.exec(line);
    if (procedureMatch) { procedure = `${procedureMatch[1]}(${procedureMatch[2].replace(/\s*,\s*/gu, ", ")})`; continue; }
    if (/^\s*end(?:for|procedure)\s*$/iu.test(line)) continue;

    const indent = /^\s*/u.exec(line)?.[0].replace(/\t/gu, "    ").length || 0;
    let text = line.trim();
    const ifMatch = /^lif\s*\{([^}]*)\}\s*return\s+(.+?)\s+lendif$/iu.exec(text);
    if (ifMatch) text = `If ${ifMatch[1]}, return ${ifMatch[2]}.`;
    const forMatch = /^For\{([^}]*)\}\s*$/iu.exec(text);
    if (forMatch) text = `For ${forMatch[1]}:`;
    text = text.replace(/^return\s+/iu, "Return ");
    const commentParts = text.split(/\s+#\s+/u);
    steps.push({ level: Math.max(0, Math.floor(indent / 4)), text: commentParts[0] });
    if (commentParts[1]) steps.push({ level: Math.max(1, Math.floor(indent / 4) + 1), text: `Note: ${commentParts.slice(1).join(" # ")}` });
  }
  if (input) output.push(`**Input:** ${input}`);
  if (result) output.push(`**Output:** ${result}`);
  if (procedure) output.push("", `#### Procedure: ${procedure}`);
  if (steps.length) {
    output.push("", "#### Steps");
    for (const step of steps) output.push(`${"   ".repeat(step.level)}1. ${step.text}`);
  }
  return trimOuter(output.join("\n"));
}

export function collectPandocReferenceLabels(blocks) {
  const labels = new Map();
  for (const block of blocks) {
    const value = String(block.markdown || "");
    for (const match of value.matchAll(/!\[([^\]\n]*)\]\((?:\\.|[^)\n])+\)\{([^}\n]*)\}/gu)) {
      const attrs = attributes(match[2]);
      if (attrs.id) labels.set(attrs.id, match[1].trim() || "Figure");
      for (const dataValue of Object.values(attrs.data)) labels.set(dataValue, match[1].trim() || "Figure");
    }
    const algorithm = /^```[ \t]*\{([^}\n]*\.algorithm[^}\n]*)\}/u.exec(value);
    if (algorithm) {
      const attrs = attributes(algorithm[1]);
      if (attrs.id) labels.set(attrs.id, attrs.title || "Algorithm");
      for (const value of Object.values(attrs.data)) labels.set(value, attrs.title || "Algorithm");
    }
    const heading = /^#{1,6}\s+(.+?)(?:\s*\{([^}\n]*)\})?\s*$/u.exec(value.split("\n")[0] || "");
    if (heading?.[2]) {
      const attrs = attributes(heading[2]);
      if (attrs.id) labels.set(attrs.id, heading[1].trim());
      for (const value of Object.values(attrs.data)) labels.set(value, heading[1].trim());
    }
    const container = /^:::\s*\{([^}\n]*)\}/u.exec(value);
    if (container) {
      const attrs = attributes(container[1]);
      if (attrs.id) labels.set(attrs.id, attrs.title || attrs.classes[0] || "Note");
      for (const value of Object.values(attrs.data)) labels.set(value, attrs.title || attrs.classes[0] || "Note");
    }
    for (const match of value.matchAll(/\\label\{([^}\n]+)\}/gu)) labels.set(match[1], "Equation");
  }
  return labels;
}

function replaceCrossReferences(markdown, labels, events) {
  return String(markdown || "").replace(/\[([^\]\n]+)\]\(\)\{\.(ref|eqref)\}/gu, (_full, key, kind) => {
    events.push({ type: "cross_reference", key, reference_kind: kind });
    if (labels.has(key)) return labels.get(key);
    if (kind === "eqref" || /(?:^|[-_:])eq(?:uation)?/iu.test(key)) return "corresponding equation";
    if (/fig(?:ure)?/iu.test(key)) return "related figure";
    if (/alg(?:orithm)?/iu.test(key)) return "related algorithm";
    if (/(?:^|[-_:])ex(?:ercise)?/iu.test(key)) return "related exercise";
    if (/chap(?:ter)?|sec(?:tion)?/iu.test(key)) return "related section";
    return "related content";
  });
}

function normalizeVisibleAttributes(markdown, events) {
  let value = String(markdown || "");
  value = value.replace(/(\]\((?:\\.|[^)\n])+\))\{([^}\n]*)\}/gu, (_full, target, raw) => {
    events.push({ type: "image_or_link_attributes", attributes: attributes(raw) });
    return target;
  });
  value = value.replace(/^(#{1,6}\s+.*?)[ \t]*\{([^}\n]*)\}[ \t]*$/gmu, (_full, heading, raw) => {
    events.push({ type: "heading_attributes", attributes: attributes(raw) });
    return heading.trimEnd();
  });
  value = value.replace(/^(\s*>[ \t]*#{1,6})[ \t]+\{([^}\n]*)\}[ \t]*$/gmu, (_full, prefix, raw) => {
    const attrs = attributes(raw);
    const kind = attrs.classes.find((item) => new Set(["lemma", "remark", "proof", "objectives"]).has(item)) || "note";
    events.push({ type: kind, attributes: attrs });
    return `${prefix} ${semanticLabel(kind).replace(/^###\s+/u, "")}`;
  });
  return value;
}

function normalizeOne(block, context, labels) {
  const original = String(block.markdown || "");
  const events = [];
  let markdown = original;

  const algorithm = /^```[ \t]*\{([^}\n]*\.algorithm[^}\n]*)\}\s*\n([\s\S]*?)\n```\s*$/u.exec(original);
  if (algorithm) {
    const attrs = attributes(algorithm[1]);
    markdown = `${semanticLabel("algorithm", attrs.title)}\n\n${normalizeAlgorithmBody(algorithm[2])}`;
    events.push({ type: "algorithm", attributes: attrs });
  } else {
    const codeAttributeFence = /^```[ \t]*\{([^}\n]*)\}/u.exec(original);
    const codeAttrs = codeAttributeFence ? attributes(codeAttributeFence[1]) : null;
    const codeLanguage = codeAttrs?.classes.find((item) => !new Set(["numberLines", "sourceCode", "code", "lineAnchors"]).has(item)) || "";
    const codeWithAttributes = codeAttributeFence && codeLanguage ? codeAttributeFence : null;
    if (codeWithAttributes) {
      markdown = original.replace(/^```[ \t]*\{[^}\n]*\}/u, `\`\`\`${codeLanguage}`);
      events.push({ type: "true_code_fence", language: codeLanguage, attributes: codeAttrs });
    } else if (/^```|^~~~/u.test(original.trim())) {
      events.push({ type: "true_code_fence" });
    }

    // A real source-code fence is protected content. Apart from converting a
    // Pandoc language attribute on the opening fence, do not normalize its
    // internal whitespace, cross references, or attribute-looking text.
    if (codeWithAttributes || /^```|^~~~/u.test(original.trim())) {
      return {
        block: {
          ...block,
          source_markdown: original,
          markdown,
          type: "code"
        },
        events
      };
    }

    const opener = /^:::\s*\{([^}\n]*)\}\s*(?:\n|$)/u.exec(markdown);
    if (opener) {
      const attrs = attributes(opener[1]);
      const kind = attrs.classes.find((item) => new Set(["exercise", "proof", "remark", "objectives", "lemma"]).has(item)) || "note";
      if (kind === "exercise") context.exerciseNumber += 1;
      const heading = semanticLabel(kind, attrs.title, kind === "exercise" ? context.exerciseNumber : null);
      markdown = `${heading}\n\n${markdown.slice(opener[0].length)}`;
      events.push({ type: kind, attributes: attrs, number: kind === "exercise" ? context.exerciseNumber : null });
    }
    if (/^\s*:::\s*$/u.test(markdown)) {
      markdown = "<!-- semantic-container-end -->";
      events.push({ type: "container_end" });
    } else {
      const withoutClosers = markdown.replace(/^:::\s*$/gmu, "").replace(/\n{3,}/gu, "\n\n");
      if (withoutClosers !== markdown) events.push({ type: "container_end" });
      markdown = withoutClosers;
    }
  }

  markdown = replaceCrossReferences(markdown, labels, events);
  markdown = normalizeVisibleAttributes(markdown, events);
  markdown = trimOuter(markdown);
  return {
    block: {
      ...block,
      source_markdown: original,
      markdown,
      type: /^```|^~~~/u.test(markdown) ? "code" : algorithm ? "paragraph" : block.type,
      ...(algorithm ? { semantic_kind: "algorithm", translation_scope: "atomic_preserve" } : {})
    },
    events
  };
}

export function normalizePandocSemanticBlocks(blocks, { enabled = true, referenceLabels = {} } = {}) {
  if (!enabled) return { blocks, normalizations: [], counts: {} };
  const labels = collectPandocReferenceLabels(blocks);
  for (const [key, label] of Object.entries(referenceLabels || {})) {
    if (key && label) labels.set(key, label);
  }
  const context = { exerciseNumber: 0 };
  const normalized = [];
  const normalizations = [];
  const counts = {};
  for (const block of blocks) {
    const result = normalizeOne(block, context, labels);
    normalized.push(result.block);
    if (result.events.length) {
      normalizations.push({ source_block_key: block.source_block_key, events: result.events });
      for (const event of result.events) counts[event.type] = (counts[event.type] || 0) + 1;
    }
  }
  return { blocks: normalized, normalizations, counts };
}
