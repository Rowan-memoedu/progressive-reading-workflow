"""Independent, model-free readback of an accepted Markdown media projection."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import unquote


def sha(data):
    return hashlib.sha256(data).hexdigest()


def literal_mermaid(text):
    lines = text.splitlines(keepends=True)
    output = []
    index = 0
    while index < len(lines):
        match = re.match(r'^([ \t]*)(-\s+)?(`{3,}|~{3,})([^\r\n]*)\r?\n?$', lines[index])
        if not match:
            index += 1
            continue
        start = index
        index += 1
        indent=len(match[1])+len(match[2] or '')
        closing = re.compile(r'^[ \t]*' + re.escape(match[3][0]) + r'{' + str(len(match[3])) + r',}[ \t]*$')
        while index < len(lines) and not closing.fullmatch(lines[index].rstrip('\r\n')):
            index += 1
        assert index < len(lines), 'Unclosed fenced code'
        if match[4].strip().lower() == 'mermaid':
            block=[]
            for offset,line in enumerate(lines[start:index+1]):
                if offset and indent:
                    assert line.startswith(' '*indent), 'Invalid native diagram indentation'
                block.append(line[indent:])
            output.append(''.join(block).rstrip('\r\n'))
        index += 1
    return output


def verify(audit):
    receipt = json.loads((audit / 'media-projection.json').read_text('utf-8'))
    reading = Path(receipt['reading_path'])
    output_bytes = reading.read_bytes()
    output = output_bytes.decode('utf-8')
    before_bytes = (audit / 'accepted-before.md').read_bytes()
    before = before_bytes.decode('utf-8')
    book_bytes = Path(receipt['book_path']).read_bytes()
    assert sha(book_bytes) == receipt['book_sha256']
    assert sha(before_bytes) == receipt['input_sha256']
    assert sha(output_bytes) == receipt['output_sha256']
    assert (audit / 'with-media.md').read_bytes() == output_bytes
    for field in ['captions', 'source_result']:
        assert sha(Path(receipt[field+'_path']).read_bytes()) == receipt[field+'_sha256']
    restored = output.encode('utf-16-le')
    for insertion in reversed(receipt['insertions']):
        offset = insertion['output_offset'] * 2
        literal = insertion['text'].encode('utf-16-le')
        assert restored[offset:offset+len(literal)] == literal
        restored = restored[:offset] + restored[offset+len(literal):]
        assert insertion['input_offset'] > before.index('## 正文'), 'Media entered the reading guide'
    assert restored.decode('utf-16-le') == before, 'Accepted text changed'
    original_diagrams = literal_mermaid(book_bytes.decode('utf-8'))
    output_diagrams = literal_mermaid(output)
    assert Counter(original_diagrams) == Counter(output_diagrams), 'Mermaid differs from book.md'
    assert len(original_diagrams) == receipt['counts']['mermaid']
    references = re.findall(r'!\[[^\]\n]*\]\((images/[^)\n]+)\)', output)
    paths = [(reading.parent / unquote(value)).resolve() for value in references]
    used = set(receipt['used_attachments'])
    assert len(paths) == receipt['counts']['images']
    assert not re.search(r'(?<!!)\[[^\]\n]*\]\((?:images/|_assets/)[^)\n]+\)', output), 'Image became an ordinary link'
    assert not re.search(r'^#{1,6}\s+(?:来源附件|附件列表)\s*$', output, re.M)
    assert set(paths) == {Path(item['published_path']).resolve() for item in receipt['assets'] if item['path'] in used}
    for asset in receipt['assets']:
        assert sha(Path(asset['source_path']).read_bytes()) == asset.get('source_sha256',asset['sha256'])
        assert sha(Path(asset['published_path']).read_bytes()) == asset['sha256']
    anchors = re.findall(r'(?:^|\s)\^(pr-[a-z0-9-]+)(?=\s|$)', output, re.M)
    assert anchors == re.findall(r'(?:^|\s)\^(pr-[a-z0-9-]+)(?=\s|$)', before, re.M)
    assert all(anchor in anchors for anchor in re.findall(r'\[\[#\^(pr-[a-z0-9-]+)\|', output))
    report = {'status':'passed', 'reading_path':str(reading), 'sha256':sha(output_bytes),
        'accepted_text_unchanged':True, 'text_acceptance':receipt.get('text_acceptance','user_review_required'),
        'mermaid_blocks_byte_identical':len(original_diagrams), 'image_embeds':len(paths),
        'retained_assets_hash_verified':len(receipt['assets']), 'guide_anchors_unchanged':True,
        'no_appendix_created':True, 'model_calls':receipt['model_calls']}
    assert report['model_calls'] == 0
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audit', type=Path, required=True)
    args = parser.parse_args()
    report = verify(args.audit)
    (args.audit / 'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
