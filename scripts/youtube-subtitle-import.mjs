import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { youtubeVideoIdentity } from './url-import-input.mjs';
import { parseVtt, groupTranscriptSegments } from './import-youtube-subtitle-canary.mjs';

const execFileAsync = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
export const YOUTUBE_SUBTITLE_WORKFLOW_VERSION = 'youtube-subtitles/v1';
export { youtubeVideoIdentity };

function originalTrack(formats) {
  return formats.filter(format => {
    try { return !new URL(format.url).searchParams.has('tlang'); } catch { return false; }
  });
}

export function selectSubtitleTrack(info) {
  const preferred = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'zh-TW', info.language, 'en', 'en-US', 'en-GB'].filter(Boolean);
  for (const [kind, tracks] of [['manual', info.subtitles], ['automatic', info.automatic_captions]]) {
    const available = Object.entries(tracks || {}).flatMap(([language, entries]) => {
      if (language === 'live_chat') return [];
      const formats = kind === 'automatic' ? originalTrack(entries) : entries;
      const format = formats.find(item => item.ext === 'vtt');
      return format ? [{ language, kind, ext: 'vtt' }] : [];
    });
    available.sort((a, b) => {
      const rank = item => { const index = preferred.indexOf(item.language); return index < 0 ? 100 : index; };
      return rank(a) - rank(b) || a.language.localeCompare(b.language);
    });
    if (available.length) return available[0];
  }
  throw new Error('youtube_subtitles_unavailable_asr_disabled');
}

export function subtitleIntegrity(segments, paragraphs, duration, rawVtt) {
  if (!segments.length) throw new Error('youtube_subtitles_empty');
  const chars = segments.map(item => item.text).join('').replace(/\s/gu, '').length;
  if (chars < 80) throw new Error('youtube_subtitles_too_short');
  const reconstructed = paragraphs.map(item => item.text).join('').replace(/\s/gu, '');
  if (reconstructed !== segments.map(item => item.text).join('').replace(/\s/gu, '')) throw new Error('youtube_subtitle_text_coverage_failed');
  const toSeconds = value => String(value).split(':').reduce((total, part) => total * 60 + Number(part), 0);
  const ends = [...rawVtt.matchAll(/-->\s+(\d{2}:\d{2}:\d{2}\.\d+)/gu)].map(match => toSeconds(match[1]));
  if (!ends.length) throw new Error('youtube_subtitle_format_invalid');
  const endSeconds = Math.max(...ends);
  // Reject clearly truncated tracks; retain the measured timeline, since an
  // intro/outro or silence need not have captions at every instant.
  if (Number(duration) > 120 && endSeconds < duration * 0.8) throw new Error('youtube_subtitle_timeline_incomplete');
  if (Number(duration) > 0 && endSeconds > duration + 60) throw new Error('youtube_subtitle_timeline_invalid');
  return { cue_count: segments.length, paragraph_count: paragraphs.length, visible_text_chars: chars,
    text_coverage: 1, first_caption_seconds: toSeconds(segments[0].start),
    last_caption_seconds: endSeconds, video_duration_seconds: Number(duration || 0) };
}

export function youtubeCookieFile(cookies, nowSeconds = Date.now() / 1000) {
  const relevant = cookies.filter(cookie => /(^|\.)youtube\.com$/iu.test(cookie.domain)
    && !cookie.partitionKey && (cookie.session || cookie.expirationDate > nowSeconds));
  return '# Netscape HTTP Cookie File\n' + relevant.map(cookie => {
    const domain = cookie.domain.replace(/^\./u, '');
    const fields = [cookie.hostOnly ? domain : `.${domain}`, cookie.hostOnly ? 'FALSE' : 'TRUE', cookie.path || '/',
      cookie.secure ? 'TRUE' : 'FALSE', cookie.session ? '0' : String(Math.floor(cookie.expirationDate)), cookie.name, cookie.value];
    if (fields.some(value => /[\r\n\t]/u.test(String(value)))) throw new Error('youtube_cookie_format_invalid');
    return fields.join('\t');
  }).join('\n') + '\n';
}

async function invokeYtDlp(args) {
  try {
    const result = await execFileAsync(process.env.PROGRESSIVE_READING_YTDLP || 'yt-dlp', args,
      { windowsHide: true, timeout: 180000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
    return result.stdout;
  } catch (error) {
    // Never expose signed URLs, credentials, or arbitrary subprocess output.
    const message = String(error.stderr || error.message || '');
    const code = error.code === 'ENOENT' ? 'tool_missing' : /429|Too Many Requests/iu.test(message) ? 'rate_limited'
      : /Sign in|login|cookies are no longer valid|confirm your age/iu.test(message) ? 'login_required'
      : /not available|unavailable|Private video/iu.test(message) ? 'video_unavailable'
      : /timed out|ETIMEDOUT/iu.test(message) || error.killed ? 'timeout' : 'acquisition_failed';
    throw new Error(`youtube_${code}`);
  }
}

export async function fetchYoutubeSubtitleDraft(requestedUrl, {
  artifactRoot = process.env.PROGRESSIVE_READING_YOUTUBE_ARTIFACT_ROOT || 'D:/Artifacts/ProgressiveReading/youtube-subtitles',
  liveSnapshot, runYtDlp = invokeYtDlp, onProgress = () => {}
} = {}) {
  const identity = youtubeVideoIdentity(requestedUrl);
  if (!identity) throw new Error('unsupported_youtube_video_url');
  const outputDir = path.join(artifactRoot, identity.id);
  const privateRoot = liveSnapshot?.dataRoot || 'D:/AppData/ProgressiveReading/BrowserAuth';
  await fs.mkdir(outputDir, { recursive: true });
  if (liveSnapshot) await liveSnapshot.protectDirectory();
  else await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const infoPath = path.join(privateRoot, `youtube-${token}.info.json`);
  const cookiePath = path.join(privateRoot, `youtube-${token}.cookies.txt`);
  const base = ['--ignore-config', '--no-playlist', '--skip-download', '--ignore-no-formats-error', '--no-progress',
    '--js-runtimes', `node:${process.execPath}`, '--remote-components', 'ejs:github',
    '--cache-dir', process.env.PROGRESSIVE_READING_YTDLP_CACHE || 'D:/Caches/yt-dlp',
    '--socket-timeout', '30', '--retries', '2'];
  let authenticated = false;
  async function refreshCookieFile() {
    if (!liveSnapshot) return;
    const header = liveSnapshot.headerForUrl(identity.url);
    authenticated = Boolean(header);
    await fs.writeFile(cookiePath, youtubeCookieFile(liveSnapshot.jar.cookies), { mode: 0o600 });
  }
  try {
    onProgress({ stage: 'youtube_metadata', video_id: identity.id });
    // Keep the existing public-subtitle route. yt-dlp recommends account cookies
    // only for account-required sources; authenticated player responses can omit
    // otherwise available manual captions. Reuse live Chrome auth when required.
    let info;
    try { info = JSON.parse(await runYtDlp([...base, '--dump-single-json', identity.url])); }
    catch (error) {
      if (error.message !== 'youtube_login_required' || !liveSnapshot) throw error;
      await refreshCookieFile();
      if (!authenticated) throw error;
      base.push('--cookies', cookiePath);
      info = JSON.parse(await runYtDlp([...base, '--dump-single-json', identity.url]));
    }
    if (info.id !== identity.id || info._type === 'playlist') throw new Error('youtube_metadata_identity_mismatch');
    if (info.is_live) throw new Error('youtube_live_stream_not_finished');
    const track = selectSubtitleTrack(info);
    await fs.writeFile(infoPath, JSON.stringify(info), { mode: 0o600 });
    if (authenticated) await refreshCookieFile();
    onProgress({ stage: 'youtube_subtitles', video_id: identity.id, language: track.language, kind: track.kind });
    await runYtDlp([...base, '--load-info-json', infoPath, track.kind === 'manual' ? '--write-subs' : '--write-auto-subs',
      '--sub-langs', `^${track.language.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, '--sub-format', track.ext,
      '--force-overwrites', '-o', path.join(outputDir, '%(id)s.%(ext)s')]);
    const subtitlePath = path.join(outputDir, `${identity.id}.${track.language}.${track.ext}`);
    const raw = await fs.readFile(subtitlePath, 'utf8');
    const segments = parseVtt(raw);
    const paragraphs = groupTranscriptSegments(segments);
    const integrity = subtitleIntegrity(segments, paragraphs, info.duration, raw);
    const markdown = paragraphs.map(item => item.text).join('\n\n');
    const capturedAt = new Date().toISOString();
    const metadata = { source_url: identity.url, canonical_url: identity.url, source_platform: 'YouTube',
      source_type: 'youtube_video_transcript', source_id: identity.id, title: info.title || identity.id,
      author: info.channel || info.uploader || '', duration: Number(info.duration || 0),
      language: track.language, subtitle_language: track.language, subtitle_kind: track.kind,
      input_form: 'spoken_transcript', source_is_original: true, capture_agent: 'yt_dlp_subtitles',
      workflow_version: YOUTUBE_SUBTITLE_WORKFLOW_VERSION, content_integrity: integrity,
      subtitle_sha256: hash(raw), transcript_sha256: hash(markdown), raw_artifact_dir: outputDir };
    await fs.writeFile(path.join(outputDir, 'source.json'), JSON.stringify(metadata, null, 2) + '\n');
    await fs.writeFile(path.join(outputDir, 'transcript.md'), markdown + '\n');
    await fs.writeFile(path.join(outputDir, 'caption-map.json'), JSON.stringify({ segments, paragraphs, integrity }, null, 2) + '\n');
    onProgress({ stage: 'youtube_standard_preprocess', video_id: identity.id, ...integrity });
    return { requestedUrl, finalUrl: identity.url, redirectChain: [],
      fetchReceipt: { workflow_version: YOUTUBE_SUBTITLE_WORKFLOW_VERSION, subtitle_language: track.language,
        subtitle_kind: track.kind, subtitle_sha256: metadata.subtitle_sha256, content_integrity: integrity,
        raw_artifact_dir: outputDir, chrome_cookie_snapshot_used: authenticated, browser_tab_created: false,
        acquisition_mode: authenticated ? 'chrome_live_snapshot' : 'public_subtitles',
        media_downloaded: false, asr_used: false },
      draft: { id: `local-ir-youtube-${identity.id}`, url: identity.url, title: metadata.title, pageText: markdown,
        html: '', annotations: [], qaCards: [], articleMusing: null, sourceType: 'url_import',
        sourceMetadata: metadata, userInstruction: '', revision: 0, createdAt: capturedAt, updatedAt: capturedAt } };
  } finally {
    await fs.unlink(infoPath).catch(() => {});
    await fs.unlink(cookiePath).catch(() => {});
  }
}
