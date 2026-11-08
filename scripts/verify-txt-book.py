"""Verify all published book leaves independently against immutable TXT bytes."""

import argparse
import hashlib
import html
import json
import re
from pathlib import Path


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def compact(text):
    return re.sub(r"\s", "", text)


def restore(markdown):
    return html.unescape(re.sub(r"\\([\\`*_\[\]|$~#+!().-])", r"\1", markdown))


def verify_peer_granularity(manifest):
    assert manifest["split_policy_version"] == "uniform-sibling-granularity-v1"
    decisions = manifest["peer_granularity"]
    root = manifest["tree"]
    assert root["subdivide"] is True
    visited = 0

    def visit(node):
        nonlocal visited
        children = node["children"]
        if not children:
            assert node["subdivide"] is False
            return
        if not node["subdivide"]:
            # A collapsed unit must have exactly one complete published leaf.
            leaves = [split for split in manifest["splits"] if split["source_boundary"]["start_line"] <= node["start"] + 1
                      and split["source_boundary"]["end_line"] == node["end"] and split["title"] == node["title"]]
            assert len(leaves) == 1, node["title"]
            return
        rows = [decision for decision in decisions if decision["parent_line"] == node.get("line")]
        assert rows
        assert sorted(line for row in rows for line in row["peer_lines"]) == sorted(child["line"] for child in children)
        if node is not root:
            assert len(rows) == 1 and rows[0]["group"] == "siblings"
        for row in rows:
            peers = [child for child in children if child["line"] in row["peer_lines"]]
            indivisible = [peer["line"] for peer in peers if not peer["children"]]
            expected = not indivisible
            assert row["indivisible_peer_lines"] == indivisible
            assert row["subdivide"] is expected
            assert all(peer["subdivide"] is expected for peer in peers)
            visited += 1
        for child in children:
            visit(child)

    visit(root)
    assert visited == len(decisions)
    return visited


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("package", type=Path)
    parser.add_argument("audit", type=Path)
    args = parser.parse_args()
    package = load(args.package / "manifest.json")
    metadata = load(args.package / "source.json")
    manifest = load(args.audit / "book-manifest.json")
    report = load(args.audit / "book-publication.json")
    source_bytes = args.source.read_bytes()
    assert sha(source_bytes) == package["source"]["sha256"]
    assert source_bytes == (args.package / package["source"]["copy_path"]).read_bytes()
    for record in package["files"]:
        assert sha((args.package / record["path"]).read_bytes()) == record["sha256"]
    source = source_bytes.decode(metadata["encoding"], errors="strict")
    raw = (args.package / "raw.md").read_text(encoding="utf-8")
    assert compact(restore(raw)) == compact(source)
    assert sha(raw.encode()) == manifest["source_sha256"]
    raw_lines = raw.split("\n")
    book = Path(report["book_root"])
    assert report["status"] == "completed"
    assert report["split_count"] == len(manifest["splits"]) == len(report["rows"])
    peer_groups = verify_peer_granularity(manifest)
    assert {file.relative_to(book).as_posix() for file in book.rglob("*.md")} == {split["relative_path"] for split in manifest["splits"]}
    cursor = 1
    restored_parts = []
    for split, row in zip(manifest["splits"], report["rows"]):
        assert row["split_id"] == split["split_id"]
        assert row["relative_path"] == split["relative_path"]
        start, end = split["source_boundary"]["start_line"], split["source_boundary"]["end_line"]
        assert start == cursor and end >= start
        cursor = end + 1
        expected = "\n".join(raw_lines[start - 1:end])
        assert sha(expected.encode()) == split["source_sha256"]
        reading_path = book / split["relative_path"]
        assert reading_path.resolve() == Path(row["publication"]["path"]).resolve()
        assert sha(reading_path.read_bytes()) == row["publication"]["sha256"]
        reading = reading_path.read_text(encoding="utf-8")
        body = reading.split("\n## 正文\n", 1)[1]
        assert compact(restore(body)) == compact(restore(expected)), split["relative_path"]
        restored_parts.append(restore(body))
        section_audit = args.audit / "sections" / split["split_id"]
        result = load(section_audit / "result.json")
        request = load(section_audit / "request.json")
        publication = load(section_audit / "publication.json")
        assert compact(request["material"]["markdown"]) == compact(expected)
        assert request["processing_options"]["include_reading_guide"] is False
        assert result["status"] == "completed"
        assert result["artifacts"]["semantic"]["judgments"] is None
        assert result["artifacts"]["semantic"]["insights"] == []
        assert result["receipt"]["reading_guide"]["status"] == "skipped"
        assert result["receipt"]["model"]["calls"] == 0
        assert publication["status"] == "published" and publication["quality_status"] == "ready"
        assert publication["failed_validations"] == []
    assert cursor == len(raw_lines) + 1
    assert compact("\n".join(restored_parts)) == compact(source)
    verification = {
        "passed": True,
        "book_root": str(book),
        "files": len(manifest["splits"]),
        "source_nonempty_lines": sum(bool(line.strip()) for line in source.splitlines()),
        "full_source_coverage": True,
        "no_overlap_or_omission": True,
        "uniform_sibling_granularity": True,
        "verified_peer_groups": peer_groups,
        "all_publication_hashes_match": True,
        "guide_generated": False,
        "model_calls": 0,
        "source_sha256": sha(source_bytes),
    }
    (args.audit / "independent-book-validation.json").write_text(json.dumps(verification, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(verification, ensure_ascii=False))


if __name__ == "__main__":
    main()
