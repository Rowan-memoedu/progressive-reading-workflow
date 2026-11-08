"""Independent local readback of source coverage and written-outline evidence."""
import argparse
import hashlib
from collections import Counter
import json
from pathlib import Path
import re


def body_stats(value):
    value = re.sub(r"```[\s\S]*?```|\$\$[\s\S]*?\$\$", "", value)
    lines = value.splitlines()
    ordinary = "\n".join(line for line in lines if not re.match(r"^\s*#{1,6}\s", line))
    return {
        "characters": len(re.sub(r"\s", "", ordinary)),
        "headings": sum(bool(re.match(r"^#{2,3}\s", line)) for line in lines),
        "top_level_items": sum(bool(re.match(r"^-\s", line)) for line in lines),
        "nested_items": sum(bool(re.match(r"^(?: {2})+-\s", line)) for line in lines),
        "oral_markers": {word: ordinary.count(word) for word in ["这个", "那个", "然后", "就是"]},
        "unstructured_long_lines": [line[:100] for line in lines if len(line) > 120 and not re.match(r"^\s*(?:-|#{1,6}|\||>)", line)],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--baseline-run", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    new = json.loads((args.run / "preprocess/result.json").read_text(encoding="utf-8"))
    old = json.loads((args.baseline_run / "preprocess/result.json").read_text(encoding="utf-8"))
    receipt = json.loads((args.run / "video-receipt.json").read_text(encoding="utf-8"))
    manifest = new["artifacts"]["cleaning_manifest"]
    assert manifest["source_nodes"] == old["artifacts"]["cleaning_manifest"]["source_nodes"]
    assert Counter(node["id"] for node in manifest["source_nodes"]) == Counter(mapping["source_id"] for mapping in manifest["mappings"])
    assert not manifest["ai_additions"]
    chunks = receipt["spoken_quality"]["chunks"]
    assert chunks and all(chunk["status"] == "passed" and chunk["attempts"][-1]["review"]["verdict"] == "pass"
                          and not chunk["attempts"][-1]["review"]["issues"] for chunk in chunks)
    new_stats = body_stats(manifest["body_text"])
    old_stats = body_stats(old["artifacts"]["cleaning_manifest"]["body_text"])
    assert new_stats["top_level_items"] > 0 and new_stats["nested_items"] > 0
    assert not new_stats["unstructured_long_lines"]
    report = {"status": "passed", "same_original_source_nodes": True, "source_nodes": len(manifest["source_nodes"]),
              "markdown_sha256": hashlib.sha256(Path(receipt["publication"]["markdown"]["path"]).read_bytes()).hexdigest(),
              "reviewed_chunks": len(chunks), "all_source_and_quality_reviews_passed": True,
              "baseline": old_stats, "refined": new_stats,
              "used_attachments": receipt["used_attachments"], "attachment_layout": receipt["attachment_layout"]}
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
