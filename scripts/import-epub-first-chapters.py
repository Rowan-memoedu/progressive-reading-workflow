"""Reuse TOC-aware extraction for standard processing of selected EPUB chapters."""
import argparse
import json
import re
import hashlib
from pathlib import Path
from rich_text_import.core import build_package, _downstream_request

parser = argparse.ArgumentParser()
parser.add_argument('source')
parser.add_argument('--output', required=True)
parser.add_argument('--chapters', type=int, default=1)
parser.add_argument('--language', default='en')
parser.add_argument('--resume', action='store_true')
args = parser.parse_args()
if args.resume:
    root = Path(args.output)
    manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    assert hashlib.sha256(Path(args.source).read_bytes()).hexdigest() == manifest['source']['sha256']
    for record in manifest['files']:
        assert hashlib.sha256((root / record['path']).read_bytes()).hexdigest() == record['sha256']
    result = {'output_dir': str(root), 'manifest': manifest}
else:
    result = build_package(args.source, args.output, literature_chapter_count=args.chapters)
root = Path(result['output_dir'])
source = json.loads((root / 'source.json').read_text(encoding='utf-8'))
assert source['requested_literature_chapters'] == args.chapters
if result['manifest']['status'] != 'completed':
    raise SystemExit(json.dumps(result, ensure_ascii=False))
labels = [entry['label'] for entry in source['literature_chapters']]
source.update(title=source['title'] + ' — ' + '; '.join(labels),
              source_url=Path(args.source).resolve().as_uri(), source_is_original=True,
              content_profile='natural_language', language=args.language)
markdown = (root / 'raw.md').read_text(encoding='utf-8')
anchors = set(re.findall(r'<a id="([^"]+)">', markdown))
def source_link(match):
    target = match.group(1)
    if target in anchors:
        return match.group(0)
    return '](' + Path(args.source).resolve().as_uri() + '#' + target.removeprefix('source-') + ')'
markdown = re.sub(r'\]\(#([^)]+)\)', source_link, markdown)
request = _downstream_request(markdown=markdown,
    source_type='epub', source_metadata=source,
    user_instruction='不生成阅读前置导读卡和核心洞察；其余翻译、原文保留、图片链接、正文格式及完整性校验沿用标准流程。',
    language=args.language, content_profile='natural_language')
request['processing_options']['include_reading_guide'] = False
# Keep extraction evidence immutable; the standard request is a separate adapter output.
(root / 'standard-request.json').write_text(json.dumps(request, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'status': result['manifest']['status'], 'request': str(root / 'standard-request.json'), 'chapters': labels}, ensure_ascii=False))
