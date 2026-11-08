"""Independent XHTML-to-Markdown ordered text coverage check."""
import argparse
import hashlib
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('source')
p.add_argument('package')
args = p.parse_args()
root = Path(args.package)
metadata = json.loads((root / 'source.json').read_text(encoding='utf-8'))
selection = metadata['literature_chapters']
assert len(selection) == 1
fragment = selection[0]['fragment']
with zipfile.ZipFile(args.source) as archive:
    document = ET.fromstring(archive.read(selection[0]['source_path']))
body = next(node for node in document.iter() if node.tag.endswith('}body'))
active = False
nodes = []
for node in body:
    if any(child.get('id') == fragment for child in node.iter()):
        active = True
    elif active and node.tag.endswith('}h2'):
        break
    if active:
        nodes.append(node)
normalize = lambda text: ''.join(char for char in text if char.isalnum())
markdown = (root / 'raw.md').read_text(encoding='utf-8')
plain = re.sub(r'!?\[([^\]]*)\]\([^)]*\)', r'\1', markdown)
plain = re.sub(r'<[^>]+>', '', plain)
target = normalize(plain)
cursor = 0
missing = []
checked = 0
text_nodes = []
for node in nodes:
    if node.tag.rsplit('}', 1)[-1] in {'ul', 'ol'}:
        text_nodes.extend(child for child in node.iter() if child.tag.endswith('}li'))
    else:
        text_nodes.append(node)
for index, node in enumerate(text_nodes):
    text = normalize(''.join(node.itertext()))
    if not text:
        continue
    checked += 1
    found = target.find(text, cursor)
    if found < 0:
        missing.append({'index': index, 'excerpt':text[:120]})
    else:
        cursor = found + len(text)
report = {'source_sha256':hashlib.sha256(Path(args.source).read_bytes()).hexdigest(),
          'chapter':selection[0]['label'], 'checked_source_nodes':checked,
          'missing_or_reordered_nodes':missing,
          'source_images':sum(1 for node in nodes for child in node.iter() if child.tag.endswith('}img')),
          'next_chapter_absent':'Chapter 2.' not in markdown,
          'passed':not missing and 'Chapter 2.' not in markdown}
(root / 'independent-source-validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
raise SystemExit(0 if report['passed'] else 1)
