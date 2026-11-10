"""Extract only verified ordinary blobs; never execute repository contents."""
import hashlib
import json
import os
import pathlib
import stat
import sys
import zipfile

archive, tree_file, target, content_root = sys.argv[1:]
tree = json.loads(pathlib.Path(tree_file).read_text(encoding='utf-8'))
if tree.get('truncated'):
    raise ValueError('repository_tree_truncated')
prefix = content_root.rstrip('/') + '/' if content_root else ''
expected = {r['path']: r for r in tree['tree'] if r['type'] == 'blob' and r['path'].startswith(prefix)}
if not expected or len(expected) > 20000:
    raise ValueError('repository_source_count_invalid')
base = pathlib.Path(target).resolve()
seen = set()
total = 0
with zipfile.ZipFile(archive) as z:
    for entry in z.infolist():
        if entry.is_dir():
            continue
        parts = pathlib.PurePosixPath(entry.filename).parts
        if len(parts) < 2:
            continue
        name = '/'.join(parts[1:])
        if name not in expected:
            continue
        row = expected[name]
        if row['mode'] not in ('100644', '100755') or stat.S_ISLNK(entry.external_attr >> 16):
            raise ValueError('repository_nonordinary_blob:' + name)
        if name in seen or any(p in ('..', '.') or ':' in p or '\\' in p for p in parts):
            raise ValueError('repository_path_invalid:' + name)
        total += entry.file_size
        if entry.file_size > 16 * 1024 * 1024 or total > 256 * 1024 * 1024:
            raise ValueError('repository_size_limit')
        data = z.read(entry)
        blob_hash = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        if blob_hash != row['sha']:
            raise ValueError('repository_blob_hash_mismatch:' + name)
        destination = base.joinpath(*pathlib.PurePosixPath(name).parts).resolve()
        if not destination.is_relative_to(base):
            raise ValueError('repository_path_escape')
        # Windows' ordinary pathname API rejects valid deeply nested archives.
        native = pathlib.Path('\\\\?\\' + str(destination)) if os.name == 'nt' else destination
        native.parent.mkdir(parents=True, exist_ok=True)
        native.write_bytes(data)
        seen.add(name)
if seen != set(expected):
    raise ValueError('repository_archive_incomplete')
print(json.dumps({'verified_blobs': len(seen), 'bytes': total}))
