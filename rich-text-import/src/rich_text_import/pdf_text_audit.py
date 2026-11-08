"""Local PDF text-layer / MinerU / Markdown comparison; never calls a model.

Bag coverage deliberately tolerates column reordering. Differences are evidence
for targeted inspection, not proof that either extractor is authoritative.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import html
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import unicodedata

import pdfplumber
from pypdf import PdfReader

POLICY = "pdf-text-layer-audit/v1"
FURNITURE = {"header", "footer", "page_number"}
CJK = "\\u3400-\\u9fff\\uf900-\\ufaff"
TOKENS = re.compile(rf"[{CJK}]|[^\W\d_{CJK}]+(?:'[^\W\d_{CJK}]+)*|\d+(?:\.\d+)?", re.UNICODE)


def _sha256(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def _plain(markdown: str) -> str:
    text = re.sub(r"<!--[\s\S]*?-->", "", markdown)
    text = re.sub(r"!\[[^\]\n]*\]\([^\n]*?\)", "", text)
    text = re.sub(r"\[([^\]\n]*)\]\([^\n]*?\)", r"\1", text)
    text = re.sub(r"<[^>]+>", " ", text)
    return html.unescape(text)


def _normalise(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("\u00ad", "").translate(str.maketrans({"’": "'", "‘": "'", "‐": "-", "‑": "-"}))
    text = re.sub(r"(?<=[^\W\d_])-[ \t]*\r?\n[ \t]*(?=[^\W\d_])", "", text)
    text = re.sub(r"(?<=[^\W\d_])-(?=[^\W\d_])", "", text)
    text = re.sub(r"(?<=\d),(?=\d{3}(?:\D|$))", "", text)
    return text


def _counter(text: str) -> Counter:
    return Counter(token.casefold() for token in TOKENS.findall(_normalise(text)))


def _watermark_key(character: dict) -> tuple | None:
    matrix = character.get("matrix", (1, 0))
    angle = math.degrees(math.atan2(matrix[1], matrix[0]))
    if abs(angle) <= 5:
        return None
    return (character.get("text"), character.get("fontname"), round(character["x0"]*2), round(character["top"]*2), round(angle))


def _simplify_many(texts: list[str]) -> list[str]:
    cli = Path(__file__).resolve().parents[3] / "standard-preprocessing" / "chinese-script-cli.mjs"
    result = subprocess.run(
        [shutil.which("node") or "node", str(cli)],
        input=json.dumps({"texts": texts}, ensure_ascii=False),
        capture_output=True, text=True, encoding="utf-8", timeout=60, check=True,
    )
    values = json.loads(result.stdout)["texts"]
    if len(values) != len(texts):
        raise ValueError("text_projection_count_mismatch")
    return values


def _item_text(item: dict) -> str:
    if item.get("type") in FURNITURE:
        return ""
    if item.get("type") == "aside_text" and re.fullmatch(r"(?:\d+\s*)+", str(item.get("text", ""))):
        return ""
    values = [str(item.get(key, "")) for key in ("text", "code_body", "table_body")]
    for kind in ("image", "chart", "table"):
        for suffix in ("caption", "footnote"):
            value = item.get(f"{kind}_{suffix}", [])
            values.extend([value] if isinstance(value, str) else map(str, value))
    return _plain("\n\n".join(values))


def _native_quality(text: str, error: str | None) -> str:
    if error:
        return "extraction_error"
    if not text.strip():
        return "no_text_layer"
    bad = sum(character == "\ufffd" or unicodedata.category(character) in {"Co", "Cc"} and character not in "\n\r\t" for character in text)
    if bad / max(len(text), 1) > 0.02 or len(re.findall(r"\(cid:\d+\)", text)) >= 3:
        return "unreliable_encoding"
    return "comparable"


def _diff(expected: Counter, actual: Counter) -> dict:
    missing = expected - actual
    total = sum(expected.values())
    return {"expected_tokens": total, "matched_tokens": total - sum(missing.values()),
            "coverage": round((total - sum(missing.values())) / max(total, 1), 6),
            "missing_tokens": sum(missing.values()), "missing_samples": dict(missing.most_common(40))}


def _suspicious_code(markdown: str, original: str) -> list[dict]:
    prose = re.sub(r"(?ms)^ {0,3}(`{3,}|~{3,})[^\n]*\n.*?^ {0,3}\1\s*$", "", markdown)
    found = []
    for match in re.finditer(r"(?<!`)`([^`\n]+)`(?!`)", prose):
        value = match[1]
        if match[0] in original or len(value.split()) < 2:
            continue
        declaration = re.fullmatch(r"(?:(?:public|private|protected|abstract|final|static)\s+)+(?:class|interface|enum|record)\s+[A-Za-z_$][\w$]*", value)
        if declaration or re.search(r"[(){};=]", value):
            continue
        if re.fullmatch(r"[A-Za-z][A-Za-z '\-]+", value):
            found.append({"span": value, "reason": "new_inline_code_without_code_syntax", "context": prose[max(0, match.start()-90):match.end()+90]})
    return found


def split_markdown_pages(markdown: str, page_count: int) -> list[str]:
    matches = list(re.finditer(r"<!-- pdf-page:(\d+) -->", markdown))
    if [int(match[1]) for match in matches] != list(range(1, page_count + 1)):
        raise ValueError("pdf_page_markers_missing_or_reordered")
    return [markdown[match.end():matches[index+1].start() if index+1 < len(matches) else len(markdown)] for index, match in enumerate(matches)]


def build_text_audit(source: Path, content: list[dict], markdown_pages: list[str]) -> dict:
    source = source.resolve()
    before = _sha256(source)
    reader = PdfReader(str(source), strict=False)
    if len(markdown_pages) != len(reader.pages):
        raise ValueError("pdf_audit_page_count_mismatch")
    items = [[] for _ in reader.pages]
    for item in content:
        index = int(item.get("page_idx", -1))
        if not 0 <= index < len(items):
            raise ValueError("pdf_audit_invalid_page_index")
        items[index].append(item)
    native, comparison_native = [], []
    with pdfplumber.open(str(source)) as document:
        rotated = Counter()
        for physical in document.pages:
            rotated.update({key for character in physical.chars if (key := _watermark_key(character)) is not None})
        watermark_keys = {key for key, occurrences in rotated.items() if occurrences >= max(3, math.ceil(len(reader.pages)/2))}
        for index, page in enumerate(reader.pages):
            error = None
            try:
                text = page.extract_text() or ""
            except Exception as exception:
                text, error = "", type(exception).__name__
            regions = [item["bbox"] for item in items[index]
                       if item.get("type") in FURNITURE | {"image", "chart", "equation"}
                       and len(item.get("bbox", [])) == 4]
            physical = document.pages[index]
            filtered = physical.filter(lambda obj: obj.get("object_type") != "char" or _watermark_key(obj) not in watermark_keys)
            visible, last_top = [], None
            # Small caps use different glyph sizes inside one word. Font size
            # must not introduce token boundaries absent from the source text.
            for word in filtered.extract_words(use_text_flow=True):
                x = (word["x0"] + word["x1"]) * 500 / max(physical.width, 1)
                y = (word["top"] + word["bottom"]) * 500 / max(physical.height, 1)
                if any(box[0] <= x <= box[2] and box[1] <= y <= box[3] for box in regions):
                    continue
                separator = "\n" if last_top is not None and abs(word["top"]-last_top) > 3 else " "
                visible.append(separator + word["text"])
                last_top = word["top"]
            comparison_text = "".join(visible).strip()
            comparison_native.append(comparison_text)
            native.append({"page": index+1, "text": text, "comparison_text": comparison_text,
                           "quality": _native_quality(text, error), "extraction_error": error})
    count = len(native)
    ocr = ["\n\n".join(_item_text(item) for item in page) for page in items]
    rendered = [_plain(page) for page in markdown_pages]
    projections = _simplify_many(comparison_native + ocr + rendered)
    native_counts = [_counter(projections[index]) for index in range(count)]
    ocr_counts = [_counter(projections[count+index]) for index in range(count)]
    rendered_counts = [_counter(projections[2*count+index]) for index in range(count)]
    eligible = [i for i, page in enumerate(native) if page["quality"] == "comparable"]
    document_missing = sum((native_counts[i] for i in eligible), Counter()) - sum((ocr_counts[i] for i in eligible), Counter())
    # A relocated passage needs an exact five-token witness on another page.
    # Whole-document deficits cannot be explained away by matching a duplicate.
    shingle_index = {}
    for index in range(count):
        tokens = [token.casefold() for token in TOKENS.findall(_normalise(projections[count+index]))]
        for offset in range(len(tokens)-4):
            shingle_index.setdefault(tuple(tokens[offset:offset+5]), set()).add(index)
    pages = []
    for index, record in enumerate(native):
        layer = _diff(native_counts[index], ocr_counts[index])
        adapter = _diff(ocr_counts[index], rendered_counts[index])
        missing = native_counts[index] - ocr_counts[index]
        numeric = {key: value for key, value in missing.items() if re.fullmatch(r"\d+(?:\.\d+)?", key)}
        capitals = {token.casefold() for token in re.findall(r"\b[A-Z][a-z]{2,}\b", _normalise(record["text"]))}
        names = {key: value for key, value in missing.items() if key in capitals}
        adjacent = None
        if layer["missing_tokens"] and record["quality"] == "comparable":
            neighbours = range(max(0, index-1), min(count, index+2))
            adjacent = _diff(sum((native_counts[i] for i in neighbours), Counter()), sum((ocr_counts[i] for i in neighbours), Counter()))
        relocated, relocation_witnesses = Counter(), []
        source_tokens = [token.casefold() for token in TOKENS.findall(_normalise(projections[index]))]
        covered_positions = set()
        for offset in range(len(source_tokens)-4):
            witness = tuple(source_tokens[offset:offset+5])
            destinations = shingle_index.get(witness, set()) - {index}
            if destinations and index not in shingle_index.get(witness, set()):
                covered_positions.update(range(offset, offset+5))
                if len(relocation_witnesses) < 12:
                    relocation_witnesses.append({"phrase": " ".join(witness), "ocr_pages": sorted(page+1 for page in destinations)})
        if covered_positions:
            relocated = missing & (Counter(source_tokens[position] for position in covered_positions) - document_missing)
        remaining = missing - relocated
        remaining_coverage = (sum(native_counts[index].values())-sum(remaining.values())) / max(sum(native_counts[index].values()), 1)
        boundary_shift = bool(relocated and sum(remaining.values()) < 8 and remaining_coverage >= 0.94)
        code = _suspicious_code(markdown_pages[index], "\n".join(str(item.get("text", "")) for item in items[index]))
        status = "not_comparable" if record["quality"] != "comparable" else "matched"
        if record["quality"] == "comparable" and layer["missing_tokens"]:
            status = "boundary_shift" if boundary_shift else "review" if layer["missing_tokens"] >= 8 and layer["coverage"] < 0.94 else "minor_difference"
        if adapter["missing_tokens"] or code:
            status = "review"
        pages.append({"page": index+1, "status": status, "reference_quality": record["quality"],
                      "text_layer_vs_ocr": layer, "ocr_vs_markdown": adapter,
                      "numeric_difference_candidates": numeric, "capitalized_word_difference_candidates": names,
                      "adjacent_pages_comparison": adjacent,
                      "relocated_tokens": sum(relocated.values()), "unexplained_missing_tokens": sum(remaining.values()),
                      "relocation_witnesses": relocation_witnesses, "suspicious_inline_code": code})
    document = _diff(sum((native_counts[i] for i in eligible), Counter()), sum((ocr_counts[i] for i in eligible), Counter()))
    after = _sha256(source)
    if before != after:
        raise ValueError("pdf_changed_during_text_audit")
    report = {"policy": POLICY, "source": str(source), "source_sha256": before,
              "source_unchanged": True, "model_calls": 0, "external_service_calls": 0,
              "normalization": ["Unicode NFKC", "OpenCC t2s", "line-end dehyphenation", "casefold", "punctuation and whitespace", "order-insensitive token counts"],
              "excluded_regions": ["headers", "footers", "page numbers", "image/chart/equation interiors", "rotated characters repeating at identical geometry on at least 3 and half of all pages"],
              "status": "review" if any(page["status"] == "review" for page in pages) else "compared",
              "summary": {"pages": count, "comparable_pages": len(eligible), "review_pages": [page["page"] for page in pages if page["status"] == "review"],
                          "noncomparable_pages": [page["page"] for page in pages if page["reference_quality"] != "comparable"],
                          "boundary_shift_pages": [page["page"] for page in pages if page["status"] == "boundary_shift"],
                          "adapter_missing_tokens": sum(page["ocr_vs_markdown"]["missing_tokens"] for page in pages),
                          "suspicious_inline_code": sum(len(page["suspicious_inline_code"]) for page in pages)},
              "rotated_watermark_character_signatures": len(watermark_keys),
              "document_text_layer_vs_ocr": document, "pages": pages,
              "interpretation": "Local differences are inspection candidates, not confirmed OCR errors; no automatic model/OCR rerun or text replacement."}
    return {"report": report, "text_layer": {"policy": POLICY, "source_sha256": before, "extractor": "pypdf", "pages": native}}


def write_text_audit(audit: dict, output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    for name, value in [("text-layer.json", audit["text_layer"]), ("comparison.json", audit["report"])]:
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    (output / "text-layer.txt").write_text("\n\n".join(f"=== PDF page {page['page']} ===\n{page['text']}" for page in audit["text_layer"]["pages"]), encoding="utf-8")
    report = audit["report"]
    lines = ["# PDF 文本层自动对照", "", f"- 原件 SHA-256：`{report['source_sha256']}`", f"- 页面统计：{json.dumps(report['summary'], ensure_ascii=False)}", "- 新增模型与外部服务调用：0。差异不自动触发重跑或正文修改。", "- 字符、数字和大写词差异是待定位候选；文本层并非唯一正确答案。", ""]
    for page in report["pages"]:
        if page["status"] not in {"review", "boundary_shift"} and not page["numeric_difference_candidates"]:
            continue
        lines.extend([f"## 第 {page['page']} 页：{page['status']}", "", f"- 文本层覆盖：{page['text_layer_vs_ocr']['coverage']:.2%}", f"- 缺失词/字候选：{json.dumps(page['text_layer_vs_ocr']['missing_samples'], ensure_ascii=False)}", f"- 数字候选：{json.dumps(page['numeric_difference_candidates'], ensure_ascii=False)}", f"- 大写词候选：{json.dumps(page['capitalized_word_difference_candidates'], ensure_ascii=False)}", f"- OCR 到 Markdown 缺失：{page['ocr_vs_markdown']['missing_tokens']}", f"- 代码误标候选：{json.dumps(page['suspicious_inline_code'], ensure_ascii=False)}", ""])
    (output / "report.md").write_text("\n".join(lines)+"\n", encoding="utf-8")
    return {name: f"{output.name}/{name}" for name in ("text-layer.json", "text-layer.txt", "comparison.json", "report.md")}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--mineru-result", required=True, type=Path)
    parser.add_argument("--markdown", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    if not arguments.output.resolve().is_relative_to(root):
        raise ValueError("pdf_audit_output_outside_project")
    if arguments.output.exists():
        raise ValueError("pdf_audit_output_already_exists")
    from .mineru_pdf import _validate_result_dir
    _, content_path = _validate_result_dir(arguments.source.resolve(), arguments.mineru_result.resolve())
    content = json.loads(content_path.read_text(encoding="utf-8"))
    markdown = arguments.markdown.read_text(encoding="utf-8")
    count = len(PdfReader(str(arguments.source)).pages)
    audit = build_text_audit(arguments.source, content, split_markdown_pages(markdown, count))
    audit["report"]["markdown_sha256"] = _sha256(arguments.markdown)
    paths = write_text_audit(audit, arguments.output)
    print(json.dumps({"ok": True, "output": str(arguments.output.resolve()), "status": audit["report"]["status"], "summary": audit["report"]["summary"], "files": paths, "model_calls": 0}, ensure_ascii=False))


if __name__ == "__main__":
    main()
