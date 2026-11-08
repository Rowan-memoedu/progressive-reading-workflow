"""Read-only, fail-closed extraction for text-layer PDFs.

This module deliberately does not perform OCR.  It produces page-addressable
Markdown and provenance/quality data that a caller can pass to the existing
progressive-reading preprocessing boundary.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import mimetypes
from pathlib import Path
import re
from statistics import median
from typing import Any

import pdfplumber
from PIL import Image
from pypdf import PdfReader


EXTRACTOR_NAME = "rich-text-import.pdf"
EXTRACTOR_VERSION = "0.3.0"
_SPACE_RE = re.compile(r"\s+")
_FORMULA_RE = re.compile(r"(?:[=<>±×÷∑∫√^]|\b(?:sin|cos|tan|log|lim)\b)")
_MONO_FONT_RE = re.compile(
    r"(?:courier|consolas|liberationmono|dejavusansmono|sourcecodepro|notosansmono|monospace)",
    re.IGNORECASE,
)
_DINGBAT_FONT_RE = re.compile(r"(?:wingdings|webdings|zapfdingbats)", re.IGNORECASE)
_CODE_TEXT_RE = re.compile(
    r"(?:"
    r"^\s*(?:package|import|public|private|protected|class|static|void|boolean|byte|short|int|long|float|double|char|String|Scanner|if|else|for|while|do|switch|case|break|continue|return|System\.)\b"
    r"|//"
    r"|[;；{}](?:\s|$)"
    r")"
)
_CAPTION_RE = re.compile(r"^(?:figure|fig\.?|table|图|表)\s*[0-9一二三四五六七八九十]+[.：:]?", re.IGNORECASE)
_BROWSER_SAFE_IMAGE_SUFFIXES = {".gif", ".jpeg", ".jpg", ".png", ".webp"}


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
            "decorative_image_count": 0,
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
        runs: list[list[dict[str, Any]]] = [[]]
        previous_x1: float | None = None
        for char in ordered:
            x0 = float(char.get("x0", 0.0))
            size = float(char.get("size", 0.0) or 0.0)
            # A large horizontal void is a column/text-box boundary, not a
            # space inside one sentence.  Splitting here prevents side-by-side
            # slide content from being flattened into one synthetic line.
            if (
                previous_x1 is not None
                and x0 - previous_x1 > max(36.0, size * 3.0)
                and runs[-1]
            ):
                runs.append([])
            runs[-1].append(char)
            previous_x1 = float(char.get("x1", x0))

        for run in runs:
            line = _line_from_chars(run, group["top"])
            if line is not None:
                lines.append(line)
    return _merge_dingbat_bullets(lines)


def _line_from_chars(
    ordered: list[dict[str, Any]],
    top: float,
) -> dict[str, Any] | None:
    """Build one visual line while retaining its horizontal extent."""

    if not ordered:
        return None
    mixed_dingbat = any(
        _DINGBAT_FONT_RE.search(str(char.get("fontname", "")))
        for char in ordered
    ) and not all(
        _DINGBAT_FONT_RE.search(str(char.get("fontname", "")))
        for char in ordered
    )
    dingbat_x0 = [
        float(char.get("x0", 0.0))
        for char in ordered
        if _DINGBAT_FONT_RE.search(str(char.get("fontname", "")))
    ]
    normal_x0 = [
        float(char.get("x0", 0.0))
        for char in ordered
        if not _DINGBAT_FONT_RE.search(str(char.get("fontname", "")))
    ]
    pieces: list[str] = []
    previous_x1: float | None = None
    sizes: list[float] = []
    fonts: list[str] = []
    for char in ordered:
        text = str(char.get("text", ""))
        font = str(char.get("fontname", ""))
        if mixed_dingbat and _DINGBAT_FONT_RE.search(font):
            continue
        x0 = float(char.get("x0", 0.0))
        size = float(char.get("size", 0.0) or 0.0)
        if previous_x1 is not None and x0 - previous_x1 > max(1.5, size * 0.22):
            pieces.append(" ")
        pieces.append(text)
        previous_x1 = float(char.get("x1", x0))
        if size:
            sizes.append(size)
        fonts.append(font)
    text = _SPACE_RE.sub(" ", "".join(pieces)).strip()
    if (
        mixed_dingbat
        and dingbat_x0
        and normal_x0
        and min(dingbat_x0) < min(normal_x0)
    ):
        text = f"- {text}"
    text = re.sub(r"^[▪•]\s*", "- ", text)
    if not text:
        return None
    return {
        "top": top,
        "bottom": max(float(char.get("bottom", top)) for char in ordered),
        "x0": min(float(char.get("x0", 0.0)) for char in ordered),
        "x1": max(float(char.get("x1", 0.0)) for char in ordered),
        "text": text,
        "size": median(sizes) if sizes else 0.0,
        "fonts": fonts,
    }


def _merge_dingbat_bullets(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Attach mis-decoded PowerPoint dingbat bullets to their text line.

    PDF text extractors commonly expose a Wingdings bullet as ``}`` or a
    private-use glyph on a separate, vertically overlapping line.  Font
    provenance lets us recover the list marker without deleting legitimate
    braces from source code.
    """

    bullet_indexes = {
        index
        for index, line in enumerate(lines)
        if len(line.get("text", "").strip()) == 1
        and line.get("fonts")
        and all(_DINGBAT_FONT_RE.search(font) for font in line["fonts"])
    }
    if not bullet_indexes:
        return lines

    output = [dict(line) for line in lines]
    for bullet_index in sorted(bullet_indexes):
        bullet = output[bullet_index]
        candidates: list[tuple[float, float, int]] = []
        bullet_centre = (float(bullet["top"]) + float(bullet["bottom"])) / 2
        for index, line in enumerate(output):
            if index in bullet_indexes:
                continue
            overlap = min(float(bullet["bottom"]), float(line["bottom"])) - max(
                float(bullet["top"]), float(line["top"])
            )
            if overlap <= 0 or float(line.get("x0", 0.0)) < float(bullet.get("x0", 0.0)):
                continue
            line_centre = (float(line["top"]) + float(line["bottom"])) / 2
            candidates.append(
                (
                    float(line.get("x0", 0.0)) - float(bullet.get("x0", 0.0)),
                    abs(line_centre - bullet_centre),
                    index,
                )
            )
        if candidates:
            target_index = min(candidates)[2]
            output[target_index]["text"] = f"- {output[target_index]['text']}"

    return [line for index, line in enumerate(output) if index not in bullet_indexes]


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
    stripped = text.strip()
    if (
        len(stripped) > 180
        or not _FORMULA_RE.search(stripped)
        or re.match(r"^[-*+]\s+", stripped)
        or "//" in stripped
        or ";" in stripped
        or "；" in stripped
        or ":" in stripped
        or "：" in stripped
        or re.match(r"^(?:and|or|if|when|where)\b", stripped, re.IGNORECASE)
    ):
        return False
    words = re.findall(r"[A-Za-z]{2,}|[\u3400-\u9fff]+", stripped)
    # Labels and full prose sentences may contain operators without being a
    # standalone display equation.  Preserve them as ordinary Markdown.
    if re.match(r"^[A-Za-z][A-Za-z ]{2,}:", stripped) or (
        len(words) > 3 and re.search(r"[.!?。！？\"“”]", stripped)
    ):
        return False
    strong_symbols = sum(stripped.count(symbol) for symbol in "±×÷∑∫√^")
    comparison_symbols = sum(stripped.count(symbol) for symbol in "=<>")
    named_functions = re.findall(r"\b(?:sin|cos|tan|log|lim)\b", stripped)
    if strong_symbols or named_functions:
        return len(words) <= 12
    if "=>" in stripped or "->" in stripped:
        return len(words) <= 3
    if comparison_symbols and not re.search(r"(?:\d|\b[A-Za-z]\b|[+*/^_()]|\b(?:true|false|null)\b)", stripped):
        return False
    return comparison_symbols > 0 and len(words) <= 6


def _looks_like_code(text: str) -> bool:
    stripped = text.strip()
    if re.fullmatch(r"https?://\S+", stripped, re.IGNORECASE):
        return False
    if "//" in stripped and not re.search(r"https?://", stripped, re.IGNORECASE):
        return True
    if re.match(
        r"^(?:package|import|public|private|protected|class|static|void|boolean|byte|short|int|long|float|double|char|String|Scanner|if|else|for|while|do|switch|case|break|continue|return|System\.)\b",
        stripped,
    ):
        return True
    if re.fullmatch(r"[{}]", stripped):
        return True
    return bool(
        re.search(
            r"\b[A-Za-z_$][\w$]*(?:\s*\[[^\]]*\])?\s*(?:=|\+=|-=|\*=|/=|%=|\+\+|--)\s*.+[;；]",
            stripped,
        )
    )


def _line_kind(
    line: dict[str, Any],
    *,
    body_size: float,
    page_height: float,
    page_max_size: float,
) -> str:
    text = line["text"]
    fonts = line["fonts"]
    is_heading = (
        body_size
        and len(text) <= 180
        and (
            line["size"] >= body_size * 1.25
            or (
                page_max_size >= body_size * 1.15
                and line["size"] >= page_max_size * 0.95
            )
        )
    )
    if is_heading:
        return "heading"
    if _looks_like_code(text) or (
        fonts
        and Counter(bool(_MONO_FONT_RE.search(font)) for font in fonts)[True]
        >= len(fonts) / 2
    ):
        return "code"
    if _looks_like_formula(text):
        return "formula"
    if _CAPTION_RE.search(text):
        return "caption"
    if body_size and line["size"] <= body_size * 0.78 and line["top"] >= page_height * 0.72:
        return "footnote"
    if text.startswith("- "):
        return "list"
    return "prose"


def _detect_column_split(
    lines: list[dict[str, Any]],
    *,
    page_width: float,
    page_height: float,
) -> float | None:
    """Detect a stable two-column/text-box split from line origins."""

    candidates = [
        line
        for line in lines
        if float(line.get("top", 0.0)) < page_height * 0.9
        and float(line.get("x1", line.get("x0", 0.0)))
        - float(line.get("x0", 0.0))
        < page_width * 0.72
    ]
    origins = sorted(float(line.get("x0", 0.0)) for line in candidates)
    if len(origins) < 4:
        return None
    gaps = [
        (origins[index + 1] - origins[index], index)
        for index in range(len(origins) - 1)
    ]
    gap, index = max(gaps, default=(0.0, 0))
    if gap < page_width * 0.15:
        return None
    split = (origins[index] + origins[index + 1]) / 2
    left_count = sum(origin < split for origin in origins)
    right_count = len(origins) - left_count
    if left_count < 2 or right_count < 2:
        return None
    return split


def _order_lines_for_reading(
    lines: list[dict[str, Any]],
    *,
    column_split: float | None,
    page_height: float,
) -> list[dict[str, Any]]:
    ordered = [dict(line) for line in lines]
    if column_split is None:
        for line in ordered:
            line["column_index"] = 0
        return sorted(ordered, key=lambda line: (line["top"], line["x0"]))

    main = [line for line in ordered if line["top"] < page_height * 0.9]
    suffix = [line for line in ordered if line["top"] >= page_height * 0.9]
    left: list[dict[str, Any]] = []
    right: list[dict[str, Any]] = []
    for line in main:
        centre = (float(line["x0"]) + float(line.get("x1", line["x0"]))) / 2
        target = left if centre < column_split else right
        line["column_index"] = 0 if target is left else 1
        target.append(line)
    for line in suffix:
        line["column_index"] = 2
    return (
        sorted(left, key=lambda line: (line["top"], line["x0"]))
        + sorted(right, key=lambda line: (line["top"], line["x0"]))
        + sorted(suffix, key=lambda line: (line["top"], line["x0"]))
    )


def _join_text(parts: list[str]) -> str:
    output = ""
    for part in parts:
        clean = part.strip()
        if not clean:
            continue
        if output.endswith("-") and re.match(r"^[a-z]", clean):
            output = output[:-1] + clean
        else:
            output = f"{output} {clean}".strip()
    return output


def _render_group(
    group: dict[str, Any],
    *,
    page_number: int,
    heading_level: str,
    list_base_x0: float,
    body_size: float,
) -> str:
    kind = group["kind"]
    lines = group["lines"]
    texts = [str(line["text"]) for line in lines]
    if kind == "heading":
        return f"{heading_level} {_join_text(texts)}"
    if kind == "code":
        code_base_x0 = min(float(line["x0"]) for line in lines)
        code_lines: list[str] = []
        for line in lines:
            unit = max(float(line.get("size", body_size) or body_size) * 0.55, 1.0)
            indent = max(0, round((float(line["x0"]) - code_base_x0) / unit))
            code_lines.append(" " * indent + str(line["text"]).strip())
        return (
            f"<!-- pdf-structure:code page={page_number} -->\n"
            f"```text\n{'\n'.join(code_lines)}\n```"
        )
    if kind == "formula":
        return (
            f"<!-- pdf-structure:formula page={page_number} -->\n"
            f"$$\n{_join_text(texts)}\n$$"
        )
    if kind == "caption":
        return (
            f"<!-- pdf-structure:caption page={page_number} -->\n"
            f"*{_join_text(texts)}*"
        )
    if kind == "footnote":
        return (
            f"<!-- pdf-structure:footnote page={page_number} -->\n"
            f"> **Footnote:** {_join_text(texts)}"
        )
    if kind == "list":
        first = re.sub(r"^-\s*", "", texts[0])
        indent_level = max(
            0,
            round((float(lines[0]["x0"]) - list_base_x0) / max(body_size * 1.5, 18.0)),
        )
        return f"{'  ' * indent_level}- {_join_text([first, *texts[1:]])}"
    return _join_text(texts)


def _render_page_text_blocks(
    lines: list[dict[str, Any]],
    *,
    page_number: int,
    body_size: float,
    page_height: float,
    page_max_size: float,
    first_heading: bool,
) -> tuple[list[dict[str, Any]], int, int, bool]:
    """Reconstruct semantic blocks before images are placed between them."""

    for line in lines:
        line["kind"] = _line_kind(
            line,
            body_size=body_size,
            page_height=page_height,
            page_max_size=page_max_size,
        )
    list_origins = [float(line["x0"]) for line in lines if line["kind"] == "list"]
    list_base_x0 = min(list_origins, default=0.0)
    groups: list[dict[str, Any]] = []
    for line in lines:
        kind = line["kind"]
        previous = groups[-1] if groups else None
        can_join = False
        if previous and previous["column_index"] == line.get("column_index", 0):
            prior_line = previous["lines"][-1]
            gap = float(line["top"]) - float(prior_line["bottom"])
            close = -2.5 <= gap <= max(12.0, body_size * 0.75)
            if kind == previous["kind"] == "code":
                can_join = close
            elif kind == previous["kind"] == "heading":
                size_ratio = min(line["size"], prior_line["size"]) / max(
                    line["size"], prior_line["size"], 1.0
                )
                can_join = close and size_ratio >= 0.85
            elif kind == "prose" and previous["kind"] in {"prose", "list"}:
                can_join = close
        if can_join:
            previous["lines"].append(line)
            previous["bottom"] = max(previous["bottom"], line["bottom"])
            previous["x0"] = min(previous["x0"], line["x0"])
            previous["x1"] = max(previous["x1"], line.get("x1", line["x0"]))
        else:
            groups.append(
                {
                    "kind": kind,
                    "lines": [line],
                    "top": line["top"],
                    "bottom": line["bottom"],
                    "x0": line["x0"],
                    "x1": line.get("x1", line["x0"]),
                    "column_index": line.get("column_index", 0),
                }
            )

    blocks: list[dict[str, Any]] = []
    heading_count = 0
    marker_count = 0
    for group in groups:
        heading_level = "##"
        if group["kind"] == "heading":
            heading_count += 1
            if first_heading:
                heading_level = "#"
                first_heading = False
        if group["kind"] in {"code", "formula", "caption", "footnote"}:
            marker_count += 1
        markdown = _render_group(
            group,
            page_number=page_number,
            heading_level=heading_level,
            list_base_x0=list_base_x0,
            body_size=body_size,
        )
        if blocks and blocks[-1]["kind"] == group["kind"] == "list" and (
            blocks[-1]["column_index"] == group["column_index"]
        ):
            blocks[-1]["markdown"] += "\n" + markdown
            blocks[-1]["bottom"] = group["bottom"]
            blocks[-1]["x0"] = min(blocks[-1]["x0"], group["x0"])
            blocks[-1]["x1"] = max(blocks[-1]["x1"], group["x1"])
        else:
            blocks.append({**group, "markdown": markdown})
    return blocks, heading_count, marker_count, first_heading


def _render_line(
    line: dict[str, Any],
    *,
    page_number: int,
    body_size: float,
    first_heading: bool,
    page_height: float,
    page_max_size: float,
) -> tuple[str, str | None]:
    text = line["text"]
    fonts = line["fonts"]
    is_heading = (
        body_size
        and len(text) <= 180
        and (
            line["size"] >= body_size * 1.25
            or (
                page_max_size >= body_size * 1.15
                and line["size"] >= page_max_size * 0.95
            )
        )
    )
    if is_heading:
        level = "#" if first_heading and line["size"] >= body_size * 1.15 else "##"
        return f"{level} {text}", "heading"
    if _looks_like_code(text) or (
        fonts
        and Counter(bool(_MONO_FONT_RE.search(font)) for font in fonts)[True]
        >= len(fonts) / 2
    ):
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
    return text, None


def _image_occurrence_bbox(occurrences: list[dict[str, Any]]) -> dict[str, float]:
    return {
        "x0": min((float(item.get("x0", 0.0)) for item in occurrences), default=0.0),
        "x1": max((float(item.get("x1", 0.0)) for item in occurrences), default=0.0),
        "top": min((float(item.get("top", 0.0)) for item in occurrences), default=0.0),
        "bottom": max((float(item.get("bottom", 0.0)) for item in occurrences), default=0.0),
    }


def _is_decorative_image(
    occurrences: list[dict[str, Any]],
    *,
    page_width: float,
    page_height: float,
    lines: list[dict[str, Any]],
    byte_count: int,
) -> bool:
    if not occurrences:
        return False
    boxes = [_image_occurrence_bbox([occurrence]) for occurrence in occurrences]
    if all(
        (
            box["top"] >= page_height * 0.8
            or (
                box["top"] >= page_height * 0.7
                and box["x1"] - box["x0"] >= page_width * 0.9
            )
        )
        and box["bottom"] >= page_height * 0.94
        and box["bottom"] - box["top"] <= page_height * 0.25
        for box in boxes
    ):
        return True
    # PowerPoint frequently stores a tiny raster shadow/effect directly under
    # selectable heading text.  It is not an independent reading asset.
    if byte_count <= 12_000:
        for box in boxes:
            if box["x1"] - box["x0"] < page_width * 0.25:
                continue
            if any(
                box["top"] <= (float(line["top"]) + float(line["bottom"])) / 2 <= box["bottom"]
                and box["x0"] <= (float(line["x0"]) + float(line.get("x1", line["x0"]))) / 2 <= box["x1"]
                for line in lines
            ):
                return True
    return False


def _write_browser_safe_image(
    image_bytes: bytes,
    source_suffix: str,
    target_stem: Path,
) -> tuple[Path, str | None, tuple[int, int] | None]:
    """Write an Obsidian/Chromium-readable asset, normalising uncommon codecs."""

    if source_suffix in _BROWSER_SAFE_IMAGE_SUFFIXES:
        target = target_stem.with_suffix(source_suffix)
        target.write_bytes(image_bytes)
        try:
            with Image.open(BytesIO(image_bytes)) as decoded:
                dimensions = decoded.size
        except Exception:
            dimensions = None
        return target, None, dimensions

    with Image.open(BytesIO(image_bytes)) as decoded:
        decoded.load()
        dimensions = decoded.size
        if decoded.mode in {"CMYK", "LAB", "HSV"}:
            decoded = decoded.convert("RGB")
        target = target_stem.with_suffix(".png")
        decoded.save(target, format="PNG")
    return target, source_suffix or ".bin", dimensions


def _extract_page_images(
    reader_page: Any,
    page_number: int,
    assets_dir: Path,
    page_images: list[dict[str, Any]],
    *,
    page_width: float,
    page_height: float,
    lines: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str], int]:
    assets: list[dict[str, Any]] = []
    warnings: list[str] = []
    try:
        images = list(reader_page.images)
    except Exception as exc:  # pypdf may reject unusual image filters.
        return [], [f"page_{page_number}:image_enumeration_failed:{type(exc).__name__}"], 0

    occurrences_by_name: dict[str, list[dict[str, Any]]] = {}
    for occurrence in page_images:
        name = str(occurrence.get("name", "")).strip()
        if name:
            occurrences_by_name.setdefault(name, []).append(occurrence)

    decorative_count = 0
    if images:
        assets_dir.mkdir(parents=True, exist_ok=True)
    decorative_names: set[str] = set()
    for index, image in enumerate(images, start=1):
        source_suffix = Path(str(getattr(image, "name", ""))).suffix.lower()
        if not re.fullmatch(r"\.[a-z0-9]{2,5}", source_suffix):
            source_suffix = ".bin"
        object_name = Path(str(getattr(image, "name", ""))).stem
        occurrences = occurrences_by_name.get(object_name, [])
        image_bytes = bytes(image.data)
        if _is_decorative_image(
            occurrences,
            page_width=page_width,
            page_height=page_height,
            lines=lines,
            byte_count=len(image_bytes),
        ):
            decorative_count += 1
            decorative_names.add(object_name)
            continue
        target_stem = assets_dir / f"page-{page_number:04d}-image-{index:03d}"
        try:
            target, normalised_from, dimensions = _write_browser_safe_image(
                image_bytes,
                source_suffix,
                target_stem,
            )
            filename = target.name
            bbox = _image_occurrence_bbox(occurrences)
            assets.append(
                {
                    "kind": "image",
                    "page_number": page_number,
                    "filename": filename,
                    "source_object_name": object_name,
                    "source_suffix": source_suffix,
                    "normalised_from": normalised_from,
                    "occurrence_count": len(occurrences) or 1,
                    "placement_top": bbox["top"],
                    "placement_bottom": bbox["bottom"],
                    "placement_x0": bbox["x0"],
                    "placement_x1": bbox["x1"],
                    "pixel_width": dimensions[0] if dimensions else None,
                    "pixel_height": dimensions[1] if dimensions else None,
                    "browser_safe": target.suffix.lower() in _BROWSER_SAFE_IMAGE_SUFFIXES,
                    "path": str(target.resolve()),
                    "output_path": str(target.resolve()),
                    "markdown_path": f"{assets_dir.name}/{filename}",
                    "sha256": _sha256(target),
                }
            )
        except Exception as exc:
            warnings.append(f"page_{page_number}:image_{index}_export_failed:{type(exc).__name__}")

    expected_names = set(occurrences_by_name) - decorative_names
    exported_names = {asset["source_object_name"] for asset in assets}
    missing_names = sorted(expected_names - exported_names)
    if missing_names:
        warnings.append(
            f"page_{page_number}:image_export_incomplete:"
            f"{len(exported_names)}_of_{len(expected_names)}_unique_objects:"
            + ",".join(missing_names)
        )
    return assets, warnings, decorative_count


def _order_page_blocks(
    blocks: list[dict[str, Any]],
    *,
    column_split: float | None,
    page_height: float,
) -> list[dict[str, Any]]:
    if column_split is None:
        return sorted(
            blocks,
            key=lambda block: (
                float(block.get("top", 0.0)),
                1 if block.get("kind") == "image" else 0,
                float(block.get("x0", 0.0)),
            ),
        )
    main = [block for block in blocks if float(block.get("top", 0.0)) < page_height * 0.9]
    suffix = [block for block in blocks if float(block.get("top", 0.0)) >= page_height * 0.9]
    left: list[dict[str, Any]] = []
    right: list[dict[str, Any]] = []
    for block in main:
        centre = (float(block.get("x0", 0.0)) + float(block.get("x1", 0.0))) / 2
        (left if centre < column_split else right).append(block)
    key = lambda block: (float(block.get("top", 0.0)), float(block.get("x0", 0.0)))
    return sorted(left, key=key) + sorted(right, key=key) + sorted(suffix, key=key)


def _status_from_warnings(warnings: list[str]) -> str:
    """Return source status without treating a lossless recovery as data loss."""

    informational_suffixes = (
        ":layout_table_rejected_to_preserve_reading_order",
    )
    degrading = [
        warning
        for warning in warnings
        if not warning.endswith(informational_suffixes)
    ]
    return "partial" if degrading else "completed"


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
                        "decorative_image_count": 0,
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
            decorative_image_count = 0
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
                page_max_size = max(sizes, default=0.0)
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
                            "kind": "table",
                            "top": float(table.bbox[1]),
                            "bottom": float(table.bbox[3]),
                            "x0": float(table.bbox[0]),
                            "x1": float(table.bbox[2]),
                            "bbox": table.bbox,
                            "markdown": (
                                f"<!-- pdf-structure:table page={page_number} index={index} -->\n"
                                f"{rendered}"
                            ),
                        }
                    )
                    structure_marker_count += 1

                content_lines = [
                    line
                    for line in lines
                    if not any(_inside_bbox(line, block["bbox"]) for block in table_blocks)
                ]
                column_split = _detect_column_split(
                    content_lines,
                    page_width=float(page.width),
                    page_height=float(page.height),
                )
                ordered_lines = _order_lines_for_reading(
                    content_lines,
                    column_split=column_split,
                    page_height=float(page.height),
                )
                text_blocks, page_heading_count, page_marker_count, first_heading = (
                    _render_page_text_blocks(
                        ordered_lines,
                        page_number=page_number,
                        body_size=body_size,
                        page_height=float(page.height),
                        page_max_size=page_max_size,
                        first_heading=first_heading,
                    )
                )
                heading_count += page_heading_count
                structure_marker_count += page_marker_count
                blocks: list[dict[str, Any]] = [*text_blocks, *table_blocks]

                page_assets, image_warnings, page_decorative_count = _extract_page_images(
                    reader.pages[page_number - 1],
                    page_number,
                    assets_dir,
                    page.images,
                    page_width=float(page.width),
                    page_height=float(page.height),
                    lines=lines,
                )
                warnings.extend(image_warnings)
                assets.extend(page_assets)
                decorative_image_count += page_decorative_count
                for index, asset in enumerate(page_assets, start=1):
                    blocks.append(
                        {
                            "kind": "image",
                            "top": float(asset.get("placement_top", page.height)),
                            "bottom": float(asset.get("placement_bottom", page.height)),
                            "x0": float(asset.get("placement_x0", 0.0)),
                            "x1": float(asset.get("placement_x1", 0.0)),
                            "markdown": (
                                f"<!-- pdf-structure:image page={page_number} index={index} -->\n"
                                f"![PDF image page {page_number} index {index}]({asset['markdown_path']})"
                            ),
                        }
                    )
                    structure_marker_count += 1
                page_parts.extend(
                    block["markdown"]
                    for block in _order_page_blocks(
                        blocks,
                        column_split=column_split,
                        page_height=float(page.height),
                    )
                )
                markdown_pages.append("\n\n".join(page_parts))

        source_hash_after = _sha256(source_path)
        if source_hash_after != source_hash_before:
            warnings.append("source_changed_during_extraction")
        status = _status_from_warnings(warnings)
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
                "image_asset_count": len(assets),
                "decorative_image_count": decorative_image_count,
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
