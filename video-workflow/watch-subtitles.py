"""Exact-part adapter to the original upstream subtitle extractor; no ASR/video."""
import argparse,json,sys
from pathlib import Path


def exact_part_url(job):
    # Some authenticated uploads hide the public pagelist. Without explicit p=1,
    # yt-dlp then treats the first part as a single video and drops its part ID.
    return f"https://www.bilibili.com/video/{job['bvid']}/?p={job['part']}"


def exact_part_info(job,cookies_file,ydl_class):
    # Subtitle metadata is opt-in in yt-dlp even for download=False.
    with ydl_class({'quiet':True,'no_warnings':True,'skip_download':True,
        'writesubtitles':True,'writeautomaticsub':True,
        'noplaylist':True,'cookiefile':str(cookies_file)}) as ydl:
        info=ydl.extract_info(exact_part_url(job),download=False)
    expected={job['bvid']+'_p'+str(job['part'])}
    if job['part']==1 and job['parts']==1:expected.add(job['bvid'])
    if info.get('id') not in expected:raise ValueError('upstream_part_identity_mismatch')
    available=any(entries for kind in ['subtitles','automatic_captions']
                  for language,entries in (info.get(kind) or {}).items() if language!='danmaku')
    if not available:raise ValueError('platform_subtitles_not_yet_available')
    return info


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job',type=Path,required=True)
    parser.add_argument('--cookies-file',type=Path,required=True)
    args=parser.parse_args()
    job=json.loads(args.job.read_text('utf-8'));out=Path(job['source_dir']).resolve()
    if not out.is_relative_to(Path('D:/Artifacts/ProgressiveReading/video-watch').resolve()):
        raise ValueError('subtitle_artifact_outside_watch_root')
    out.mkdir(parents=True,exist_ok=True)
    sys.path.insert(0,str(Path(__file__).parent/'upstream/src'))
    import scraper,yt_dlp
    # yt-dlp is the library already used by upstream. Confirm explicit p=N was
    # selected before invoking its original subtitle-only extraction function.
    info=exact_part_info(job,args.cookies_file,yt_dlp.YoutubeDL)
    # Upstream uses __file__ only to locate its disposable tmp_subs. Isolate that
    # directory per job; do not touch the pinned source or any shared temp files.
    scraper.__file__=str(out/'extractor-runtime/src/scraper.py')
    (out/'extractor-runtime/src').mkdir(parents=True,exist_ok=True)
    segments=scraper.fetch_via_ytdlp(exact_part_url(job),cookies_file=str(args.cookies_file))
    if not segments:raise ValueError('empty_platform_subtitles')
    duration=float(info.get('duration') or job['duration'] or 0)
    def seconds(text):
        h,m,s=map(float,text.split(':'));return h*3600+m*60+s
    if duration<=0 or seconds(segments[-1]['end'])/duration<0.5:raise ValueError('subtitle_coverage_too_low')
    transcript={'video_id':job['bvid']+'_p'+str(job['part']),'video_url':job['url'],
      'source_url':job['url'],'title':job['title'],'duration':duration,'cid':job['cid'],
      'segments':segments,'chapters':info.get('chapters') or []}
    metadata={'source_url':job['url'],'canonical_url':job['url'],'title':job['title'],
      'source_id':transcript['video_id'],'source_platform':'Bilibili','language':'zh',
      'subtitle_file':'transcript.json','media_downloaded':False,'asr_used':False,
      'subtitle_kind':'platform_subtitles','bvid':job['bvid'],'cid':job['cid'],'part':job['part']}
    for name,value in [('transcript.json',transcript),('source.json',metadata)]:
        file=out/name
        data=(json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode()
        if file.exists() and file.read_bytes()!=data:raise ValueError('frozen_subtitle_conflict')
        file.write_bytes(data)
    print(json.dumps({'status':'acquired','segments':len(segments),'cid':job['cid']},ensure_ascii=False))

if __name__=='__main__':main()
