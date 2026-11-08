"""Independently verify a no-guide Chinese TXT publication against source bytes."""

import argparse
import hashlib
import html
import json
import re
from pathlib import Path


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def plain(markdown):
    return html.unescape(re.sub(r"\\([\\`*_\[\]|$~#+!().-])", r"\1", markdown))


def compact(text):
    return re.sub(r"\s", "", text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("package", type=Path)
    parser.add_argument("audit", type=Path)
    args = parser.parse_args()
    manifest = load(args.package / "manifest.json")
    metadata = load(args.package / "source.json")
    request = load(args.audit / "request.json")
    result = load(args.audit / "result.json")
    publication = load(args.audit / "publication.json")
    source_hash = digest(args.source)
    assert source_hash == manifest["source"]["sha256"]
    assert source_hash == digest(args.package / manifest["source"]["copy_path"])
    for record in manifest["files"]:
        assert digest(args.package / record["path"]) == record["sha256"], record["path"]
    # Decode directly using the audited encoding, independently of the adapter.
    source_text = args.source.read_bytes().decode(metadata["encoding"], errors="strict")
    raw = (args.package / "raw.md").read_text(encoding="utf-8")
    assert compact(plain(raw)) == compact(source_text)
    assert compact(plain(request["material"]["markdown"])) == compact(source_text)
    assert request["source_metadata"]["language"] == "zh"
    assert request["processing_options"]["include_reading_guide"] is False
    assert result["status"] == "completed"
    assert result["artifacts"]["semantic"]["judgments"] is None
    assert result["artifacts"]["semantic"]["insights"] == []
    assert result["receipt"]["reading_guide"]["status"] == "skipped"
    assert result["receipt"]["model"]["calls"] == 0
    assert publication["status"] == "published"
    assert publication["quality_status"] == "ready"
    assert publication["failed_validations"] == []
    published = Path(publication["markdown"]["path"])
    reading = published.read_text(encoding="utf-8")
    assert digest(published) == publication["markdown"]["sha256"]
    body = reading.split("\n## 正文\n", 1)[1]
    assert compact(plain(body)) == compact(source_text)
    assert len(result["artifacts"]["body_blocks"]) == len(result["artifacts"]["cleaning_manifest"]["source_nodes"])
    report = {
        "passed": True,
        "source_sha256": source_hash,
        "encoding": metadata["encoding"],
        "source_nonempty_lines": sum(bool(line.strip()) for line in source_text.splitlines()),
        "body_blocks": len(result["artifacts"]["body_blocks"]),
        "source_content_complete": True,
        "guide_generated": False,
        "model_calls": 0,
        "published_path": str(published),
        "publication_sha256": publication["markdown"]["sha256"],
    }
    (args.audit / "independent-txt-validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
