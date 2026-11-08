"""Validated MinerU Precision output adapter for PDF source packages."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
from typing import Any
import zipfile

import pdfplumber
from PIL import Image
from pypdf import PdfReader

from .pdf import _line_groups, _page_anchor, _anchor_markdown


EXTRACTOR_NAME = "mineru.precision"
ADAPTER_VERSION = "0.1.3"
_SAFE_IMAGE_SUFFIXES = {".gif", ".jpeg", ".jpg", ".png", ".webp"}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _validate_result_dir(source_path: Path, result_dir: Path) -> tuple[dict[str, Any], Path]:
    if not result_dir.is_dir():
        raise ValueError(f"mineru_result_dir_not_found:{result_dir}")
    required = [result_dir / "full.md", result_dir / "layout.json", result_dir / "mineru-result.zip"]
    missing = [path.name for path in required if not path.is_file() or path.stat().st_size == 0]
    if missing:
        raise ValueError("mineru_result_incomplete:" + ",".join(missing))
    with zipfile.ZipFile(result_dir / "mineru-result.zip") as archive:
        corrupt = archive.testzip()
        if corrupt:
            raise ValueError(f"mineru_result_zip_corrupt:{corrupt}")
    content_lists = [
        path
        for path in result_dir.glob("*_content_list.json")
        if not path.name.endswith("_content_list_v2.json")
    ]
    if len(content_lists) != 1:
        raise ValueError(f"mineru_content_list_count:{len(content_lists)}")
    run_manifest_path = result_dir.parent / "manifest.json"
    if not run_manifest_path.is_file():
        raise ValueError("mineru_run_manifest_missing")
    manifest = _read_json(run_manifest_path)
    result = next(
        (
            item
            for item in manifest.get("results", [])
            if str(item.get("data_id", "")) == result_dir.name
        ),
        None,
    )
    if not result or result.get("state") != "done":
        raise ValueError("mineru_result_not_done")
    if str(result.get("file_name", "")) != source_path.name:
        raise ValueError("mineru_source_filename_mismatch")
    if not str((result_dir / "full.md").read_text(encoding="utf-8")).strip():
        raise ValueError("mineru_root_markdown_empty")
    return manifest, content_lists[0]


def _source_bullet_centres(source_path: Path) -> dict[int, list[float]]:
    """Recover explicit PDF bullet glyphs without replacing MinerU text."""

    output: dict[int, list[float]] = {}
    with pdfplumber.open(str(source_path)) as document:
        for page_index, page in enumerate(document.pages):
            centres = [
                ((float(line["top"]) + float(line["bottom"])) / 2)
                * 1000
                / max(float(page.height), 1.0)
                for line in _line_groups(page)
                if str(line.get("text", "")).startswith("- ")
            ]
            output[page_index] = centres
    return output


def _is_list_item(item: dict[str, Any], bullet_centres: dict[int, list[float]]) -> bool:
    text = str(item.get("text", "")).strip()
    if re.match(r"^(?:\\?-\s+|[▶►▪•]\s*)", text):
        return True
    bbox = item.get("bbox") or []
    if len(bbox) != 4:
        return False
    page_index = int(item.get("page_idx", 0))
    return any(float(bbox[1]) - 18 <= centre <= float(bbox[3]) + 18 for centre in bullet_centres.get(page_index, []))


def _normalise_list_text(text: str) -> str:
    return re.sub(r"^(?:\\?-\s+|[▶►▪•]\s*)", "", text.strip()).strip()


def _looks_like_code_text(text: str) -> bool:
    value = str(text or "").strip()
    if not value:
        return False
    if re.match(r"^(?://|/\\?\*|\*|\*/)", value):
        return True
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    signals = sum(
        bool(
            re.search(
                r"^(?:package|import|public|private|protected|class|static|void|boolean|byte|short|int|long|float|double|char|String|Scanner|if|else|for|while|do|switch|case|break|continue|return|System\.)\b|[;{}]$",
                line,
            )
        )
        for line in lines
    )
    if len(lines) >= 2:
        return signals >= 2
    return bool(
        re.search(
            r"^(?:(?:package|import)\s+\S+;?|(?:(?:public|private|protected|abstract|final|static)\s+)*(?:class|interface|enum|record)\s+[A-Za-z_$][\w$]*|(?:(?:public|private|protected|static|final|abstract|synchronized|native)\s+)+(?:void|boolean|byte|short|int|long|float|double|char|String|[A-Za-z_$][\w$<>\[\]]*)\s+[A-Za-z_$][\w$]*\s*\([^)]*\)|(?:void|boolean|byte|short|int|long|float|double|char|String)\s+[A-Za-z_$][\w$]*\s*\([^)]*\)|(?:if|for|while|switch|catch|System\.out\.(?:print|println|printf))\s*\(|return\b|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*=)|[;{}]$",
            value,
        )
    )


def _protect_inline_code_fragments(text: str) -> str:
    value = re.sub(
        r"(?<!`)\b(?:(?:public|protected|private|abstract|final)\s+)+(?:class|interface|enum|record)\s+[A-Za-z_$][\w$]*(?=\s*(?:$|\{|extends\b|implements\b))(?!`)",
        lambda match: f"`{match.group(0)}`",
        text,
    )
    return re.sub(
        r"(?<!`)\b(?:(?:public|protected|private)\s+)(?:(?:static|final|abstract|synchronized|native)\s+)*(?:void|boolean|byte|short|int|long|float|double|char|String|[A-Za-z_$][\w$<>\[\]]*)\s+[A-Za-z_$][\w$]*\s*\([^)]*\)(?!`)",
        lambda match: f"`{match.group(0)}`",
        value,
    )


def _normalise_code_body(body: str) -> str:
    match = re.fullmatch(r"```([^\n]*)\n([\s\S]*?)\n```", body.strip())
    if not match:
        return body
    language, content = match.groups()
    lines = content.splitlines()
    depth = 0
    saw_open = False
    boundary: int | None = None
    for index, line in enumerate(lines):
        depth += line.count("{") - line.count("}")
        saw_open = saw_open or "{" in line
        if saw_open and depth <= 0 and index + 1 < len(lines):
            remainder = "\n".join(lines[index + 1 :]).strip()
            if remainder and not _looks_like_code_text(remainder) and len(re.findall(r"[A-Za-z]+", remainder)) >= 3:
                boundary = index + 1
                break
    if boundary is None:
        return body
    code = "\n".join(lines[:boundary]).rstrip()
    prose = "\n".join(lines[boundary:]).strip()
    return f"```{language}\n{code}\n```\n\n{prose}"


def _copy_image(source: Path, assets_dir: Path) -> tuple[Path, str | None]:
    suffix = source.suffix.lower()
    if suffix in _SAFE_IMAGE_SUFFIXES:
        target = assets_dir / source.name
        if not target.exists():
            shutil.copy2(source, target)
        return target, None
    with Image.open(source) as decoded:
        decoded.load()
        if decoded.mode in {"CMYK", "LAB", "HSV"}:
            decoded = decoded.convert("RGB")
        target = assets_dir / f"{source.stem}.png"
        if not target.exists():
            decoded.save(target, format="PNG")
    return target, suffix or ".bin"


def _render_item(
    item: dict[str, Any],
    *,
    page_number: int,
    result_dir: Path,
    assets_dir: Path,
    bullet_centres: dict[int, list[float]],
    asset_registry: dict[str, dict[str, Any]],
) -> tuple[str, str | None]:
    item_type = str(item.get("type", ""))
    if item_type in {"page_footnote", "ref_text"}:
        # Academic notes and bibliography entries are source content, not page
        # furniture. Keep the supplied text in its original page order.
        return str(item.get("text", "")).strip(), item_type
    if item_type == "text":
        text = str(item.get("text", "")).strip()
        if not text:
            return "", None
        level = item.get("text_level")
        if isinstance(level, int):
            if _looks_like_code_text(text):
                return f"{'#' * max(1, min(level, 6))} `{text}`", "heading"
            return f"{'#' * max(1, min(level, 6))} {_protect_inline_code_fragments(text)}", "heading"
        if _looks_like_code_text(text):
            language = "java" if re.search(r"\b(?:public|class|static|void|System\.)\b", text) else "text"
            return (
                f"<!-- pdf-structure:code page={page_number} recovered-from=text -->\n"
                f"```{language}\n{text}\n```",
                "code",
            )
        if _is_list_item(item, bullet_centres):
            return f"- {_protect_inline_code_fragments(_normalise_list_text(text))}", "list"
        return _protect_inline_code_fragments(text), None
    if item_type == "aside_text":
        text = str(item.get("text", "")).strip()
        # MinerU may expose the visual line-number gutter as aside text. It is
        # presentation chrome, while a prose annotation remains source content.
        if re.fullmatch(r"(?:\d+\s*)+", text):
            return "", None
        return f"> **Aside:** {text}", "aside"
    if item_type == "code":
        body = str(item.get("code_body", "")).strip()
        return f"<!-- pdf-structure:code page={page_number} -->\n{_normalise_code_body(body)}", "code"
    if item_type == "equation":
        body = str(item.get("text", "")).strip()
        return f"<!-- pdf-structure:formula page={page_number} -->\n{body}", "formula"
    if item_type == "table":
        body = str(item.get("table_body", "")).strip()
        caption = "\n\n".join(str(value) for value in item.get("table_caption", []) if str(value).strip())
        footnote = "\n\n".join(str(value) for value in item.get("table_footnote", []) if str(value).strip())
        body = "\n\n".join(value for value in [caption, body, footnote] if value)
        return f"<!-- pdf-structure:table page={page_number} -->\n{body}", "table"
    if item_type in {"image", "chart"}:
        relative = Path(str(item.get("img_path", "")))
        if relative.is_absolute() or ".." in relative.parts or relative.parts[:1] != ("images",):
            raise ValueError(f"mineru_image_path_invalid:{relative}")
        source = (result_dir / relative).resolve()
        if not source.is_relative_to(result_dir.resolve()) or not source.is_file():
            raise ValueError(f"mineru_image_missing:{relative.as_posix()}")
        target, normalised_from = _copy_image(source, assets_dir)
        key = str(target.resolve())
        record = asset_registry.setdefault(
            key,
            {
                "kind": "image",
                "filename": target.name,
                "source_path": relative.as_posix(),
                "normalised_from": normalised_from,
                "occurrence_count": 0,
                "page_numbers": [],
                "browser_safe": target.suffix.lower() in _SAFE_IMAGE_SUFFIXES,
                "output_path": str(target.resolve()),
                "path": str(target.resolve()),
                "markdown_path": f"{assets_dir.name}/{target.name}",
                "sha256": _sha256(target),
            },
        )
        record["occurrence_count"] += 1
        if page_number not in record["page_numbers"]:
            record["page_numbers"].append(page_number)
        caption = "\n\n".join(str(value) for value in item.get(f"{item_type}_caption", []) if str(value).strip())
        footnote = "\n\n".join(str(value) for value in item.get(f"{item_type}_footnote", []) if str(value).strip())
        body = "\n\n".join(value for value in [caption, f"![PDF image page {page_number}]({record['markdown_path']})", footnote] if value)
        return (
            f"<!-- pdf-structure:image page={page_number} -->\n{body}",
            "image",
        )
    if item_type in {"footer", "header", "page_number"}:
        return "", None
    raise ValueError(f"mineru_content_type_unsupported:{item_type or 'missing'}")


def extract_mineru_pdf(
    source_path: Path,
    assets_dir: Path,
    result_dir: Path,
) -> dict[str, Any]:
    source_path = Path(source_path).resolve()
    assets_dir = Path(assets_dir).resolve()
    result_dir = Path(result_dir).resolve()
    manifest, content_list_path = _validate_result_dir(source_path, result_dir)
    content = _read_json(content_list_path)
    if not isinstance(content, list):
        raise ValueError("mineru_content_list_invalid")
    source_hash_before = _sha256(source_path)
    page_count = len(PdfReader(str(source_path), strict=False).pages)
    anchors = [_page_anchor(number) for number in range(1, page_count + 1)]
    bullet_centres = _source_bullet_centres(source_path)
    assets_dir.mkdir(parents=True, exist_ok=True)
    asset_registry: dict[str, dict[str, Any]] = {}
    pages: list[list[dict[str, Any]]] = [[] for _ in range(page_count)]
    for item in content:
        page_index = int(item.get("page_idx", -1))
        if not 0 <= page_index < page_count:
            raise ValueError(f"mineru_page_index_invalid:{page_index}")
        pages[page_index].append(item)

    markdown_pages: list[str] = []
    markers: Counter[str] = Counter()
    character_count = 0
    for page_index, items in enumerate(pages):
        page_number = page_index + 1
        parts = [_anchor_markdown(anchors[page_index])]
        for item in items:
            rendered, marker = _render_item(
                item,
                page_number=page_number,
                result_dir=result_dir,
                assets_dir=assets_dir,
                bullet_centres=bullet_centres,
                asset_registry=asset_registry,
            )
            if rendered:
                parts.append(rendered)
                character_count += len(rendered)
            if marker:
                markers[marker] += 1
        markdown_pages.append("\n\n".join(parts))

    source_hash_after = _sha256(source_path)
    if source_hash_after != source_hash_before:
        raise ValueError("source_changed_during_mineru_adaptation")
    request_record = next(
        item
        for item in manifest.get("request_files", [])
        if str(item.get("data_id", "")) == result_dir.name
    )
    assets = list(asset_registry.values())
    from .pdf_text_audit import build_text_audit
    local_audit = build_text_audit(source_path, content, markdown_pages)
    return {
        "format": "pdf",
        "variant": "mineru_vlm",
        "status": "completed",
        "extractor": f"{EXTRACTOR_NAME}/{manifest.get('model_version', 'unknown')}+adapter-{ADAPTER_VERSION}",
        "markdown": "\n\n".join(markdown_pages).strip() + "\n",
        "local_audit": local_audit,
        "metadata": {
            "filename": source_path.name,
            "mime": "application/pdf",
            "source_sha256": source_hash_before,
            "source_sha256_after": source_hash_after,
            "source_unchanged": True,
            "format": "pdf",
            "page_count": page_count,
            "extracted_at": datetime.now(timezone.utc).isoformat(),
            "extractor": EXTRACTOR_NAME,
            "extractor_version": ADAPTER_VERSION,
            "mineru_batch_id": manifest.get("batch_id"),
            "mineru_data_id": result_dir.name,
            "mineru_model_version": manifest.get("model_version"),
            "mineru_language": manifest.get("language"),
            "mineru_ocr_enabled": request_record.get("is_ocr"),
            "mineru_table_enabled": manifest.get("enable_table"),
            "mineru_formula_enabled": manifest.get("enable_formula"),
        },
        "quality": {
            "page_count": page_count,
            "pages_with_content": sum(bool(items) for items in pages),
            "text_coverage": round(sum(bool(items) for items in pages) / max(page_count, 1), 4),
            "character_count": character_count,
            "table_count": markers["table"],
            "image_count": markers["image"],
            "image_asset_count": len(assets),
            "heading_count": markers["heading"],
            "code_block_count": markers["code"],
            "formula_count": markers["formula"],
            "list_item_count": markers["list"],
            "structure_marker_count": sum(markers.values()),
        },
        "warnings": [],
        "anchors": anchors,
        "assets": assets,
    }
