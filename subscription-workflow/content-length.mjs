export function meaningfulLength(markdown) {
  return String(markdown || '').replace(/^---\r?\n[\s\S]*?\r?\n---\s*/u,'').replace(/<!--[^]*?-->/gu,'')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu,' ').replace(/\[([^\]]+)\]\([^)]*\)/gu,'$1')
    .replace(/https?:\/\/\S+/gu,' ').replace(/[#>*_`~|\-]+/gu,' ').replace(/\s+/gu,'').length;
}
