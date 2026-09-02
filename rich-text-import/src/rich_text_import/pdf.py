"""Read-only, fail-closed extraction for text-layer PDFs.

This module deliberately does not perform OCR.  It produces page-addressable
Markdown and provenance/quality data that a caller can pass to the existing
progressive-reading preprocessing boundary.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
import mimetypes
from pathlib import Path
import re
from statistics import median
from typing import Any

import pdfplumber
from pypdf import PdfReader


EXTRACTOR_NAME = "rich-text-import.pdf"
EXTRACTOR_VERSION = "0.1.0"
_SPACE_RE = re.compile(r"\s+")
_FORMULA_RE = re.compile(r"(?:[=<>±×÷∑∫√^]|\b(?:sin|cos|tan|log|lim)\b)")
_MONO_FONT_RE = re.compile(r"(?:courier|consolas|mono|code)", re.IGNORECASE)
_CAPTION_RE = re.compile(r"^(?:figure|fig\.?|table|图|表)\s*[0-9一二三四五六七八九十]+[.：:]?", re.IGNORECASE)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _page_anchor(page_number: int) -> dict[str, Any]:
    return {
        "kind": "page",
        "page_number": page_number,
        "id": f"pdf-page-{page_number}",
    }


def _anchor_markdown(anchor: dict[str, Any]) -> str:
    return (
        f'<a id="{anchor["id"]}"></a>\n'
        f'<!-- pdf-page:{anchor["page_number"]} -->'
    )


def _failure_result(
    source_path: Path,
    status: str,
    warning: str,
    *,
    source_hash: str | None = None,
) -> dict[str, Any]:
    return {
        "format": "pdf",
        "variant": "text",
        "status": status,
        "extractor": f"{EXTRACTOR_NAME}/{EXTRACTOR_VERSION}",
        "markdown": "",
        "metadata": {
            "filename": source_path.name,
            "mime": mimetypes.guess_type(source_path.name)[0] or "application/pdf",
            "source_sha256": source_hash,
            "extracted_at": datetime.now(timezone.utc).isoformat(),
            "extractor": EXTRACTOR_NAME,
            "extractor_version": EXTRACTOR_VERSION,
        },
        "quality": {
            "page_count": 0,
            "pages_with_text": 0,
            "text_coverage": 0.0,
            "character_count": 0,
            "table_count": 0,
            "layout_tables_rejected": 0,
            "image_count": 0,
            "heading_count": 0,
            "structure_marker_count": 0,
        },
        "warnings": [warning],
        "anchors": [],
        "assets": [],
    }


def _normalise_cell(value: Any) -> str:
    if value is None:
        return ""
    return _SPACE_RE.sub(" ", str(value)).strip().replace("|", "\\|")


def _table_markdown(table: list[list[Any]]) -> str:
    rows = [[_normalise_cell(cell) for cell in row] for row in table if row]
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    header = rows[0]
    body = rows[1:]
    output = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join("---" for _ in range(width)) + " |",
    ]
    output.extend("| " + " | ".join(row) + " |" for row in body)
    return "\n".join(output)


def _line_groups(page: Any) -> list[dict[str, Any]]:
    chars = sorted(
        (char for char in page.chars if str(char.get("text", "")).strip()),
        key=lambda char: (float(char.get("top", 0.0)), float(char.get("x0", 0.0))),
    )
    groups: list[dict[str, Any]] = []
    for char in chars:
        top = float(char.get("top", 0.0))
        if not groups or abs(top - groups[-1]["top"]) > 2.5:
            groups.append({"top": top, "chars": [char]})
        else:
            groups[-1]["chars"].append(char)

    lines: list[dict[str, Any]] = []
    for group in groups:
        ordered = sorted(group["chars"], key=lambda char: float(char.get("x0", 0.0)))
        pieces: list[str] = []
        previous_x1: float | None = None
        sizes: list[float] = []
        fonts: list[str] = []
        for char in ordered:
            text = str(char.get("text", ""))
            x0 = float(char.get("x0", 0.0))
            size = float(char.get("size", 0.0) or 0.0)
            if previous_x1 is not None and x0 - previous_x1 > max(1.5, size * 0.22):
                pieces.append(" ")
            pieces.append(text)
            previous_x1 = float(char.get("x1", x0))
            if size:
                sizes.append(size)
            fonts.append(str(char.get("fontname", "")))
        text = _SPACE_RE.sub(" ", "".join(pieces)).strip()
        if text:
            lines.append(
                {
                    "top": group["top"],
                    "bottom": max(float(char.get("bottom", group["top"])) for char in ordered),
                    "text": text,
                    "size": median(sizes) if sizes else 0.0,
                    "fonts": fonts,
                }
            )
    return lines


def _inside_bbox(line: dict[str, Any], bbox: tuple[float, float, float, float]) -> bool:
    centre = (line["top"] + line["bottom"]) / 2
    return float(bbox[1]) <= centre <= float(bbox[3])


def _looks_like_layout_table(
    bbox: tuple[float, float, float, float],
    lines: list[dict[str, Any]],
    page_height: float,
) -> bool:
    """Detect page-layout boxes that pdfplumber can mistake for data tables.

    A region that encloses most text lines and a large fraction of the page is
    not safe to replace with a Markdown table: doing so destroys heading and
    paragraph structure.  It is rendered in reading order instead and reported
    as a quality downgrade for manual review.
    """

    if not lines or page_height <= 0:
        return False
    covered_lines = sum(_inside_bbox(line, bbox) for line in lines)
    text_coverage = covered_lines / len(lines)
    height_coverage = max(0.0, float(bbox[3]) - float(bbox[1])) / page_height
    return text_coverage >= 0.75 and height_coverage >= 0.35


def _looks_like_formula(text: str) -> bool:
    if len(text) > 180 or not _FORMULA_RE.search(text):
        return False
    mathematical = sum(char.isalnum() or char in " =+-*/^_()[]{}<>.,±×÷∑∫√" for char in text)
    return mathematical / max(len(text), 1) >= 0.8


def _render_line(
    line: dict[str, Any],
    *,
    page_number: int,
    body_size: float,
    first_heading: bool,
    page_height: float,
) -> tuple[str, str | None]:
    text = line["text"]
    fonts = line["fonts"]
    if fonts and Counter(bool(_MONO_FONT_RE.search(font)) for font in fonts)[True] >= len(fonts) / 2:
        return (
            f"<!-- pdf-structure:code page={page_number} -->\n```text\n{text}\n```",
            "code",
        )
    if _looks_like_formula(text):
        return (
            f"<!-- pdf-structure:formula page={page_number} -->\n$$\n{text}\n$$",
            "formula",
        )
    if _CAPTION_RE.search(text):
        return (
            f"<!-- pdf-structure:caption page={page_number} -->\n*{text}*",
            "caption",
        )
    if body_size and line["size"] <= body_size * 0.78 and line["top"] >= page_height * 0.72:
        return (
            f"<!-- pdf-structure:footnote page={page_number} -->\n> **Footnote:** {text}",
            "footnote",
        )
    if body_size and line["size"] >= body_size * 1.25 and len(text) <= 180:
        level = "#" if first_heading and line["size"] >= body_size * 1.55 else "##"
        return f"{level} {text}", "heading"
    return text, None


def _extract_page_images(
    reader_page: Any,
    page_number: int,
    assets_dir: Path,
    expected_count: int,
) -> tuple[list[dict[str, Any]], list[str]]:
    assets: list[dict[str, Any]] = []
    warnings: list[str] = []
    try:
        images = list(reader_page.images)
    except Exception as exc:  # pypdf may reject unusual image filters.
        return [], [f"page_{page_number}:image_enumeration_failed:{type(exc).__name__}"]

    if images:
        assets_dir.mkdir(parents=True, exist_ok=True)
    for index, image in enumerate(images, start=1):
        suffix = Path(str(getattr(image, "name", ""))).suffix.lower()
        if not re.fullmatch(r"\.[a-z0-9]{2,5}", suffix):
            suffix = ".bin"
        filename = f"page-{page_number:04d}-image-{index:03d}{suffix}"
        target = assets_dir / filename
        try:
            target.write_bytes(bytes(image.data))
            assets.append(
                {
                    "kind": "image",
                    "page_number": page_number,
                    "filename": filename,
                    "path": str(target.resolve()),
                    "output_path": str(target.resolve()),
                    "markdown_path": f"{assets_dir.name}/{filename}",
                    "sha256": _sha256(target),
                }
            )
        except Exception as exc:
            warnings.append(f"page_{page_number}:image_{index}_export_failed:{type(exc).__name__}")
    if expected_count > len(assets):
        warnings.append(
            f"page_{page_number}:image_export_incomplete:{len(assets)}_of_{expected_count}"
        )
    return assets, warnings


def extract_pdf(source_path: Path, assets_dir: Path) -> dict[str, Any]:
    """Extract a text-layer PDF without modifying it or silently invoking OCR."""

    source_path = Path(source_path)
    assets_dir = Path(assets_dir)
    if not source_path.is_file():
        return _failure_result(source_path, "failed", "source_file_not_found")

    try:
        source_hash_before = _sha256(source_path)
        with source_path.open("rb") as stream:
            if stream.read(5) != b"%PDF-":
                return _failure_result(
                    source_path,
                    "failed",
                    "invalid_pdf_signature",
                    source_hash=source_hash_before,
                )
        reader = PdfReader(str(source_path), strict=False)
        if reader.is_encrypted:
            try:
                if not reader.decrypt(""):
                    return _failure_result(
                        source_path,
                        "failed",
                        "encrypted_pdf_requires_password",
                        source_hash=source_hash_before,
                    )
            except Exception:
                return _failure_result(
                    source_path,
                    "failed",
                    "encrypted_pdf_requires_password",
                    source_hash=source_hash_before,
                )
        with pdfplumber.open(str(source_path)) as document:
            page_records: list[dict[str, Any]] = []
            page_texts: list[str] = []
            for page_number, page in enumerate(document.pages, start=1):
                raw_text = (page.extract_text() or "").strip()
                tables = page.find_tables()
                page_records.append(
                    {
                        "page": page,
                        "page_number": page_number,
                        "raw_text": raw_text,
                        "tables": tables,
                        "image_count": len(page.images),
                    }
                )
                page_texts.append(raw_text)

            page_count = len(page_records)
            pages_with_text = sum(bool(text) for text in page_texts)
            anchors = [_page_anchor(number) for number in range(1, page_count + 1)]
            base_metadata = {
                "filename": source_path.name,
                "mime": mimetypes.guess_type(source_path.name)[0] or "application/pdf",
                "source_sha256": source_hash_before,
                "format": "pdf",
                "page_count": page_count,
                "pdf_header": str(getattr(reader, "pdf_header", "")),
                "document_metadata": {
                    str(key): str(value)
                    for key, value in (reader.metadata or {}).items()
                    if value is not None
                },
                "extracted_at": datetime.now(timezone.utc).isoformat(),
                "extractor": EXTRACTOR_NAME,
                "extractor_version": EXTRACTOR_VERSION,
            }
            image_count = sum(record["image_count"] for record in page_records)
            if pages_with_text == 0:
                source_hash_after = _sha256(source_path)
                warning = "no_text_layer_detected;ocr_not_run"
                if source_hash_after != source_hash_before:
                    warning += ";source_changed_during_extraction"
                return {
                    "format": "pdf",
                    "variant": "text",
                    "status": "ocr_required",
                    "extractor": f"{EXTRACTOR_NAME}/{EXTRACTOR_VERSION}",
                    "markdown": "\n\n".join(_anchor_markdown(anchor) for anchor in anchors),
                    "metadata": {
                        **base_metadata,
                        "source_sha256_after": source_hash_after,
                        "source_unchanged": source_hash_after == source_hash_before,
                    },
                    "quality": {
                        "page_count": page_count,
                        "pages_with_text": 0,
                        "text_coverage": 0.0,
                        "character_count": 0,
                        "table_count": 0,
                        "layout_tables_rejected": 0,
                        "image_count": image_count,
                        "heading_count": 0,
                        "structure_marker_count": 0,
                    },
                    "warnings": [warning],
                    "anchors": anchors,
                    "assets": [],
                }

            warnings: list[str] = []
            markdown_pages: list[str] = []
            assets: list[dict[str, Any]] = []
            table_count = 0
            layout_tables_rejected = 0
            heading_count = 0
            structure_marker_count = 0
            first_heading = True
            for record in page_records:
                page_number = record["page_number"]
                page = record["page"]
                page_parts = [_anchor_markdown(anchors[page_number - 1])]
                if not record["raw_text"]:
                    warnings.append(f"page_{page_number}:missing_text_layer")
                    markdown_pages.append("\n\n".join(page_parts))
                    continue

                lines = _line_groups(page)
                sizes = [line["size"] for line in lines if line["size"] > 0]
                body_size = median(sizes) if sizes else 0.0
                table_blocks: list[dict[str, Any]] = []
                for index, table in enumerate(record["tables"], start=1):
                    if _looks_like_layout_table(
                        table.bbox,
                        lines,
                        float(page.height),
                    ):
                        layout_tables_rejected += 1
                        warnings.append(
                            f"page_{page_number}:layout_table_rejected_to_preserve_reading_order"
                        )
                        continue
                    rendered = _table_markdown(table.extract())
                    if not rendered:
                        warnings.append(f"page_{page_number}:table_{index}_extraction_failed")
                        continue
                    table_count += 1
                    table_blocks.append(
                        {
                            "top": float(table.bbox[1]),
                            "bbox": table.bbox,
                            "markdown": (
                                f"<!-- pdf-structure:table page={page_number} index={index} -->\n"
                                f"{rendered}"
                            ),
                        }
                    )
                    structure_marker_count += 1

                blocks: list[tuple[float, str]] = []
                for line in lines:
                    if any(_inside_bbox(line, block["bbox"]) for block in table_blocks):
                        continue
                    rendered, marker = _render_line(
                        line,
                        page_number=page_number,
                        body_size=body_size,
                        first_heading=first_heading,
                        page_height=float(page.height),
                    )
                    if marker == "heading":
                        first_heading = False
                        heading_count += 1
                    if marker:
                        structure_marker_count += 1
                    blocks.append((line["top"], rendered))
                blocks.extend((block["top"], block["markdown"]) for block in table_blocks)

                page_assets, image_warnings = _extract_page_images(
                    reader.pages[page_number - 1],
                    page_number,
                    assets_dir,
                    record["image_count"],
                )
                warnings.extend(image_warnings)
                assets.extend(page_assets)
                for index, asset in enumerate(page_assets, start=1):
                    image_top = (
                        float(page.images[index - 1].get("top", page.height))
                        if index <= len(page.images)
                        else float(page.height)
                    )
                    blocks.append(
                        (
                            image_top,
                            f"<!-- pdf-structure:image page={page_number} index={index} -->\n"
                            f"![PDF image page {page_number} index {index}]({asset['markdown_path']})",
                        )
                    )
                    structure_marker_count += 1
                page_parts.extend(markdown for _, markdown in sorted(blocks, key=lambda item: item[0]))
                markdown_pages.append("\n\n".join(page_parts))

        source_hash_after = _sha256(source_path)
        if source_hash_after != source_hash_before:
            warnings.append("source_changed_during_extraction")
        status = "partial" if warnings else "completed"
        return {
            "format": "pdf",
            "variant": "text",
            "status": status,
            "extractor": f"{EXTRACTOR_NAME}/{EXTRACTOR_VERSION}",
            "markdown": "\n\n".join(markdown_pages).strip() + "\n",
            "metadata": {
                **base_metadata,
                "source_sha256_after": source_hash_after,
                "source_unchanged": source_hash_after == source_hash_before,
            },
            "quality": {
                "page_count": page_count,
                "pages_with_text": pages_with_text,
                "text_coverage": round(pages_with_text / max(page_count, 1), 4),
                "character_count": sum(len(text) for text in page_texts),
                "table_count": table_count,
                "layout_tables_rejected": layout_tables_rejected,
                "image_count": image_count,
                "heading_count": heading_count,
                "structure_marker_count": structure_marker_count,
            },
            "warnings": warnings,
            "anchors": anchors,
            "assets": assets,
        }
    except Exception as exc:
        try:
            source_hash = _sha256(source_path)
        except OSError:
            source_hash = None
        return _failure_result(
            source_path,
            "failed",
            f"pdf_extraction_failed:{type(exc).__name__}",
            source_hash=source_hash,
        )
