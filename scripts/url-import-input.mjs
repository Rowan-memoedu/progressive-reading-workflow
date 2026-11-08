// Shared by the local service and its web entry. Keep the same URL identity as Obsidian.
export function trimTrailingUrlPunctuation(value) {
  let candidate = String(value || "").trim();
  const pairs = new Map([["(", ")"], ["[", "]"], ["{", "}"], ["（", "）"], ["【", "】"], ["「", "」"], ["《", "》"]]);
  const closing = new Map([...pairs].map(([a, b]) => [b, a]));
  const counts = new Map();
  for (let i = 0; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (pairs.has(char)) counts.set(char, (counts.get(char) || 0) + 1);
    if (closing.has(char)) {
      const opening = closing.get(char);
      if (!counts.get(opening)) { candidate = candidate.slice(0, i); break; }
      counts.set(opening, counts.get(opening) - 1);
    }
  }
  return candidate.replace(/[.,;:!?，。；：！？、]+$/gu, "");
}

export function normalizeHttpUrl(value) {
  try {
    const parsed = new URL(trimTrailingUrlPunctuation(value));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.toString();
  } catch { return null; }
}

export function youtubeVideoIdentity(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    let id = '';
    if (host === 'youtu.be') id = url.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/u)?.[1];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/u)?.[1];
    }
    return /^[A-Za-z0-9_-]{11}$/u.test(id || '') ? { id, url: `https://www.youtube.com/watch?v=${id}` } : null;
  } catch { return null; }
}

export function urlImportDedupeKey(value) {
  const video = youtubeVideoIdentity(value);
  if (video) return video.url;
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/iu.test(key) || /^(fbclid|gclid|mc_cid|mc_eid)$/iu.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
    return parsed.toString();
  } catch { return value; }
}

export function inspectUrls(text) {
  const pattern = /https?:\/\/[^\s<>"'`\u0000-\u001f，。；！？、]+/giu;
  const seen = new Set();
  const urls = [];
  let duplicates = 0;
  let invalid = 0;
  let match;
  while ((match = pattern.exec(String(text || "")))) {
    const candidate = trimTrailingUrlPunctuation(match[0].replace(/[,;|](?=https?:\/\/)[\s\S]*$/iu, ""));
    // Resume after the URL so adjacent Markdown links are each discovered.
    pattern.lastIndex = match.index + Math.max(candidate.length, 8);
    const url = normalizeHttpUrl(candidate);
    if (!url) { invalid += 1; continue; }
    const key = urlImportDedupeKey(url);
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    urls.push(url);
  }
  return { urls, duplicates, invalid };
}

export function extractUrls(text) { return inspectUrls(text).urls; }
