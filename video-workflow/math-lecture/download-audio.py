"""Download only the requested Bilibili part's audio using the existing yt-dlp runtime."""
import argparse
import hashlib
import json
from pathlib import Path
import time


class QuietLogger:
    def debug(self, message):
        pass

    info = debug
    warning = debug
    error = debug


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', type=Path, required=True)
    parser.add_argument('--cookies-file', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    import yt_dlp
    job = json.loads(args.job.read_text('utf-8'))
    args.output.mkdir(parents=True, exist_ok=True)
    receipt_file = args.output / 'audio.json'
    if receipt_file.exists():
        receipt = json.loads(receipt_file.read_text('utf-8'))
        file = Path(receipt['path'])
        if (receipt['cid'] != job['cid'] or receipt['video_id'] != f"{job['bvid']}_p{job['part']}"
                or hashlib.sha256(file.read_bytes()).hexdigest() != receipt['sha256']):
            raise ValueError('audio_cache_identity_mismatch')
        print(json.dumps({'status': 'audio_cached', 'cid': job['cid']}), flush=True)
        return
    last = [0.0]
    def progress(event):
        if time.monotonic() - last[0] >= 10 or event.get('status') == 'finished':
            last[0] = time.monotonic()
            print(json.dumps({'stage': 'audio_download', 'status': event.get('status'),
                              'bytes': event.get('downloaded_bytes', 0)}), flush=True)
    options = {'format': 'bestaudio', 'noplaylist': True, 'quiet': True, 'no_warnings': True,
               'logger': QuietLogger(), 'cookiefile': str(args.cookies_file),
               'outtmpl': str(args.output / 'audio.%(ext)s'), 'progress_hooks': [progress]}
    with yt_dlp.YoutubeDL(options) as ydl:
        part_url = f"https://www.bilibili.com/video/{job['bvid']}/?p={job['part']}"
        info = ydl.extract_info(part_url, download=False)
        expected = {f"{job['bvid']}_p{job['part']}"}
        if job['part'] == 1 and job['parts'] == 1:
            expected.add(job['bvid'])
        if info.get('id') not in expected:
            raise ValueError('audio_part_identity_mismatch')
        if abs(float(info.get('duration') or 0) - float(job['duration'])) > 3:
            raise ValueError('audio_part_duration_mismatch')
        info = ydl.process_ie_result(info, download=True)
        file = Path(ydl.prepare_filename(info)).resolve()
    receipt = {'video_id': f"{job['bvid']}_p{job['part']}", 'cid': job['cid'],
               'duration': info['duration'], 'path': str(file), 'bytes': file.stat().st_size,
               'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'audio_only': True}
    receipt_file.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'audio_ready', 'cid': job['cid'], 'bytes': receipt['bytes']}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Downloader errors can contain signed URLs; retain only a safe error class.
        print(json.dumps({'status': 'failed', 'error_type': type(error).__name__}))
        raise SystemExit(1)
