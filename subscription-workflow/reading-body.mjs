// Reading previews accept both processed documents and original-text imports.
export function savedReadingBody(markdown) {
  const text=String(markdown||'').replace(/\r\n?/gu,'\n');
  const structured=/^## 正文$/mu.test(text);
  let body=structured?/(?:^|\n)## 正文\n([\s\S]*?)(?=\n---\n\n## 原文\n|\n## 原文\n|$)/u.exec(text)?.[1]||'':text.replace(/^---\n[\s\S]*?\n---(?:\n|$)/u,'');
  body=body.trim().replace(/^#\s+[^\n]+\n*/u,'').replace(/^\^pr-[a-f0-9]{12}\s*$/gmu,'').trim();
  return {body,structured};
}
