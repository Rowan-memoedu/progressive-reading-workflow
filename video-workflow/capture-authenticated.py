"""Adapt existing scoped cookies to the unchanged upstream Chrome capture functions."""
import argparse
import http.cookiejar
import json
import os
import re
from pathlib import Path
import sys
from urllib.parse import urlparse
from frame_review import admit_reviewed_frames, admit_captured_frames, extend_unreviewed_request, exact, sha


def is_quality_api(url):
    parsed=urlparse(url)
    return (parsed.hostname or '').endswith('.bilibili.com') and '/playurl' in parsed.path


class ScopedCapturePage:
    def __init__(self,page):self.page=page
    def __getattr__(self,name):return getattr(self.page,name)
    def route(self,pattern,handler):
        # The upstream glob also matches CDN query values such as gen=playurlv3.
        # Limit its unchanged JSON transformer to the intended player API.
        return self.page.route(is_quality_api if pattern=='**/*playurl*' else pattern,handler)
    def locator(self,selector,*args,**kwargs):
        target=self.page.locator(selector,*args,**kwargs)
        return TimedVideo(target) if selector=='video' else target


class TimedVideo:
    def __init__(self,locator):self.target=locator
    def __getattr__(self,name):return getattr(self.target,name)
    def screenshot(self,**kwargs):
        result=self.target.screenshot(**kwargs)
        # Record what was actually rendered, including the upstream black-frame +2s fallback.
        actual=float(self.target.evaluate('(video) => video.currentTime'))
        target=Path(kwargs['path'])
        target.with_suffix('.capture.json').write_text(json.dumps({'actual_seconds':actual,'sha256':sha(target.read_bytes())})+'\n','utf-8')
        return result


class ScopedCaptureContext:
    def __init__(self,context):self.context=context
    def __getattr__(self,name):return getattr(self.context,name)
    @property
    def pages(self):return [ScopedCapturePage(page) for page in self.context.pages]
    def new_page(self):return ScopedCapturePage(self.context.new_page())
    def close(self):
        for page in self.context.pages:
            page.unroute_all(behavior='ignoreErrors')
        self.context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--cookies-file', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--frame-policy', choices=['timestamp_integrity','semantic'], default='timestamp_integrity')
    parser.add_argument('--profile-dir', type=Path, default=Path(os.environ.get('PR_VIDEO_CAPTURE_PROFILE',
        'D:/AppData/ProgressiveReading/BrowserAuth/videobook-capture-compatibility')))
    args = parser.parse_args()
    sys.path.insert(0, str(Path(__file__).parent/'upstream/src'))
    import capture_frames as upstream
    from playwright.sync_api import sync_playwright
    from PIL import Image, ImageStat
    data = json.loads((args.input/'transcript.json').read_text('utf-8'))
    platform = upstream.detect_platform(data['video_id'], data['video_url'])
    part=re.fullmatch(r'(BV[0-9A-Za-z]{10})_p([1-9]\d*)',data['video_id'])
    player_id=part.group(1) if part else data['video_id']
    plan=json.loads(args.plan.read_text('utf-8'))
    if plan.get('version')!='video-frame-plan/v2':raise ValueError('capture_plan_version_required')
    timestamps=sorted({time for frame in plan['frames'] for time in frame['candidates']})
    imgdir = args.report.parent/'frame-candidates'
    imgdir.mkdir(parents=True,exist_ok=True)
    missing = upstream.frames_missing(timestamps, str(imgdir))
    cookies=[]
    if missing:
        jar = http.cookiejar.MozillaCookieJar(str(args.cookies_file))
        jar.load(ignore_discard=True, ignore_expires=False)
        domains = ('bilibili.com',) if platform == 'bilibili' else ('youtube.com',)
        for cookie in jar:
            if not any(cookie.domain.lstrip('.') == domain or cookie.domain.endswith('.'+domain) for domain in domains):continue
            item = {'name':cookie.name,'value':cookie.value,'domain':cookie.domain,'path':cookie.path,'secure':cookie.secure}
            if cookie.expires is not None:item['expires'] = cookie.expires
            cookies.append(item)
        if not cookies:raise ValueError('capture_site_cookies_missing')

    class AuthenticatedChromium:
        def __init__(self, chromium):
            self.chromium = chromium

        def launch_persistent_context(self, *positional, **kwargs):
            context = self.chromium.launch_persistent_context(*positional, **kwargs)
            context.add_cookies(cookies)
            return ScopedCaptureContext(context)

    if missing:
        with sync_playwright() as playwright:
            class AuthenticatedPlaywright:
                chromium = AuthenticatedChromium(playwright.chromium)
            shots = upstream.shots_spec(missing, platform, player_id)
            if part:
                for shot in shots:
                    shot[2]+='&page='+part.group(2)
                    shot[3]+='&p='+part.group(2)
            print(json.dumps({'stage':'upstream_capture','frames':len(shots),'browser':'chrome','headless':True}), flush=True)
            ok = upstream._run_capture(AuthenticatedPlaywright(), shots, str(imgdir), str(args.profile_dir), player_id, platform, True)
            if not ok:
                raise ValueError('upstream_browser_capture_failed')
    if upstream.frames_missing(timestamps, str(imgdir)):
        raise ValueError('upstream_frames_missing')
    candidates = {}
    for timestamp in timestamps:
        file = imgdir/('shot_'+timestamp.replace(':','_')+'.png')
        with Image.open(file) as image:
            image.load()
            width, height = image.size
            variance = sum(ImageStat.Stat(image.convert('RGB')).var)
        if file.stat().st_size < upstream.MIN_SHOT_BYTES or min(width,height) < 360 or variance < 10:
            raise ValueError('capture_frame_quality_failed:'+file.name)
        recorded=json.loads(file.with_suffix('.capture.json').read_text('utf-8'))
        if recorded['sha256']!=sha(file.read_bytes()):raise ValueError('capture_time_metadata_mismatch')
        candidates[timestamp]={'time':timestamp,'path':str(file.resolve()),'width':width,'height':height,
                               'sha256':sha(file.read_bytes()),'actual_seconds':recorded['actual_seconds']}
    request={'version':'video-frame-review-request/v1','video_id':data['video_id'],
             'source_sha256':sha((args.input/'transcript.json').read_bytes()),'plan_sha256':sha(args.plan.read_bytes()),
             'frames':[{**frame,'candidates':[candidates[time] for time in frame['candidates']]} for frame in plan['frames']]}
    request_file=args.report.parent/'frame-review-request.json'
    review_file=args.report.parent/'frame-review.json'
    extend_unreviewed_request(request_file,request)
    if args.frame_policy == 'timestamp_integrity':
        review=admit_captured_frames(request_file,args.input/'images')
        admission_file=args.report.parent/'frame-admission.json'
        exact(admission_file,(json.dumps(review,ensure_ascii=False,indent=2)+'\n').encode())
        review={**review,'admission_sha256':sha(admission_file.read_bytes())}
    else:
        review=admit_reviewed_frames(request_file,review_file,args.input/'images')
    if review['status']!='passed':
        pending={**review,'review_request':str(request_file),'review_file':str(review_file),'frames_captured':len(candidates),
                 'body_regeneration_required':False}
        args.report.write_text(json.dumps(pending,ensure_ascii=False,indent=2)+'\n','utf-8')
        print(json.dumps({'stage':'upstream_capture',**pending}),flush=True)
        return
    upstream.materialize(str(args.input/'book.md'), str(args.input/'book.tagged.md'), str(args.input/'images'))
    if 'SCREENSHOT:' in (args.input/'book.md').read_text('utf-8'):
        raise ValueError('unmaterialized_screenshot')
    receipt = {'status':'completed','capture_engine':'pinned_upstream_capture_frames','browser':'authenticated_chrome',
               'headless':True,'media_downloaded':False,'frames':review['frames'],'frame_review':review,
               'new_capture_frames':len(missing),'frame_policy':args.frame_policy}
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n','utf-8')
    print(json.dumps({'stage':'upstream_capture','status':'completed','frames':len(review['frames'])}),flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Browser exception text can contain signed CDN URLs. Keep those out of logs.
        print(json.dumps({'stage':'upstream_capture','status':'failed','error_type':type(error).__name__,
                          'code':str(error) if isinstance(error,ValueError) else 'capture_runtime_failed'}),flush=True)
        sys.exit(1)
