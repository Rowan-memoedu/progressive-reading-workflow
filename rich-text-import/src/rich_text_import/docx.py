"""Loss-aware DOCX extraction into clean, source-neutral Markdown."""

from __future__ import annotations

import hashlib
import re
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Iterator

from docx import Document
from docx.document import Document as DocumentObject
from docx.oxml.ns import qn
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P
from docx.table import Table
from docx.text.paragraph import Paragraph
from lxml import etree


EXTRACTOR_NAME = "rich-text-import.docx"
EXTRACTOR_VERSION = "0.1.0"
_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
_WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
_M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _failed(message: str, source_path: Path) -> dict[str, Any]:
    return {
        "format": "docx",
        "variant": "office-open-xml",
        "status": "failed",
        "extractor": f"{EXTRACTOR_NAME}/{EXTRACTOR_VERSION}",
        "markdown": "",
        "metadata": {"source_filename": source_path.name},
        "quality": {
            "paragraphs_total": 0,
            "paragraphs_extracted": 0,
            "headings": 0,
            "list_items": 0,
            "tables": 0,
            "images_declared": 0,
            "images_extracted": 0,
            "hyperlinks_total": 0,
            "unsupported_objects": 0,
            "structure_preserved": False,
            "clean_markdown": False,
        },
        "warnings": [message],
        "anchors": [],
        "assets": [],
    }


def _safe_zip_members(archive: zipfile.ZipFile) -> None:
    for name in archive.namelist():
        normalized = PurePosixPath(name.replace("\\", "/"))
        if normalized.is_absolute() or ".." in normalized.parts:
            raise ValueError(f"unsafe_docx_archive_path:{name}")


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _clean_text(value: str) -> str:
    value = value.replace("\r", "\n").replace("\u00a0", " ")
    value = re.sub(r"[\u00ad\u200b\u2060\ufeff]", "", value)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in value.split("\n")]
    return "\n".join(line for line in lines if line).strip()


def _escape_inline(value: str) -> str:
    return value.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def _escape_block(value: str) -> str:
    value = _clean_text(value)
    return re.sub(r"^(#{1,6}|>|[-+*]|\d+[.)])\s", r"\\\1 ", value)


def _node_text(node: etree._Element) -> str:
    parts: list[str] = []
    for item in node.iter():
        if item.tag in {qn("w:t"), qn("w:delText"), f"{{{_M_NS}}}t"} and item.text:
            parts.append(item.text)
        elif item.tag == qn("w:tab"):
            parts.append("\t")
        elif item.tag in {qn("w:br"), qn("w:cr")}:
            parts.append("\n")
        elif item.tag == qn("w:noBreakHyphen"):
            parts.append("-")
    return _clean_text("".join(parts))


def _iter_blocks(document: DocumentObject) -> Iterator[Paragraph | Table]:
    for child in document.element.body.iterchildren():
        if isinstance(child, CT_P):
            yield Paragraph(child, document)
        elif isinstance(child, CT_Tbl):
            yield Table(child, document)


def _heading_level(paragraph: Paragraph) -> int | None:
    style = paragraph.style
    names = [getattr(style, "name", "") or "", getattr(style, "style_id", "") or ""]
    for name in names:
        match = re.search(r"(?:Heading|标题)\s*([1-6])", name, re.IGNORECASE)
        if match:
            return int(match.group(1))
    ppr = paragraph._p.pPr
    if ppr is not None:
        outline = ppr.find(qn("w:outlineLvl"))
        if outline is not None:
            raw = outline.get(qn("w:val"))
            if raw is not None and raw.isdigit():
                return min(int(raw) + 1, 6)
    if any(name.lower() == "title" for name in names):
        return 1
    return None


def _num_properties(paragraph: Paragraph) -> tuple[int, int] | None:
    candidates = [paragraph._p.pPr]
    if paragraph.style is not None:
        candidates.append(paragraph.style.element.pPr)
    for ppr in candidates:
        if ppr is None:
            continue
        num_pr = ppr.find(qn("w:numPr"))
        if num_pr is None:
            continue
        num_id_node = num_pr.find(qn("w:numId"))
        level_node = num_pr.find(qn("w:ilvl"))
        if num_id_node is None:
            continue
        num_id = int(num_id_node.get(qn("w:val"), "0"))
        level = int(level_node.get(qn("w:val"), "0")) if level_node is not None else 0
        return num_id, level
    return None


def _list_kind(document: DocumentObject, paragraph: Paragraph) -> tuple[str, int] | None:
    props = _num_properties(paragraph)
    style_name = (paragraph.style.name if paragraph.style else "").lower()
    if props is None:
        if "list bullet" in style_name:
            return "bullet", 0
        if "list number" in style_name:
            return "number", 0
        return None
    num_id, level = props
    try:
        numbering = document.part.numbering_part.element
        num = next(
            item for item in numbering.findall(qn("w:num"))
            if item.get(qn("w:numId")) == str(num_id)
        )
        abstract_id = num.find(qn("w:abstractNumId")).get(qn("w:val"))
        abstract = next(
            item for item in numbering.findall(qn("w:abstractNum"))
            if item.get(qn("w:abstractNumId")) == abstract_id
        )
        level_node = next(
            item for item in abstract.findall(qn("w:lvl"))
            if item.get(qn("w:ilvl")) == str(level)
        )
        number_format = level_node.find(qn("w:numFmt")).get(qn("w:val"), "decimal")
        return ("bullet" if number_format == "bullet" else "number"), level
    except (AttributeError, KeyError, StopIteration, ValueError):
        return "bullet", level


def _paragraph_text(paragraph: Paragraph, counters: dict[str, int]) -> str:
    parts: list[str] = []
    for child in paragraph._p.iterchildren():
        if child.tag == qn("w:hyperlink"):
            label = _node_text(child)
            if not label:
                continue
            counters["hyperlinks_total"] += 1
            relation_id = child.get(qn("r:id"))
            anchor = child.get(qn("w:anchor"))
            if relation_id and relation_id in paragraph.part.rels:
                relation = paragraph.part.rels[relation_id]
                if relation.is_external:
                    parts.append(f"[{_escape_inline(label)}]({relation.target_ref})")
                    counters["hyperlinks_external"] += 1
                    continue
            if anchor:
                counters["hyperlinks_internal_plaintext"] += 1
            parts.append(label)
        else:
            parts.append(_node_text(child))
    return _clean_text("".join(parts))


def _image_assets(
    document: DocumentObject,
    paragraph: Paragraph,
    assets_dir: Path,
    registry: dict[str, dict[str, Any]],
    counters: dict[str, int],
) -> list[str]:
    rendered: list[str] = []
    descriptions = list(paragraph._p.iter(f"{{{_WP_NS}}}docPr"))
    for index, blip in enumerate(paragraph._p.iter(f"{{{_A_NS}}}blip"), start=1):
        counters["images_declared"] += 1
        relation_id = blip.get(f"{{{_R_NS}}}embed")
        if not relation_id or relation_id not in document.part.related_parts:
            counters["images_missing"] += 1
            continue
        description = descriptions[min(index - 1, len(descriptions) - 1)] if descriptions else None
        alt = ""
        if description is not None:
            alt = description.get("descr") or description.get("title") or description.get("name") or ""
        record = registry.get(relation_id)
        if record is None:
            part = document.part.related_parts[relation_id]
            suffix = Path(str(part.partname)).suffix.lower() or ".bin"
            filename = f"image-{len(registry) + 1:04d}{suffix}"
            output_path = assets_dir / filename
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(part.blob)
            record = {
                "kind": "image",
                "source_path": str(part.partname).lstrip("/"),
                "output_path": str(output_path),
                "markdown_path": f"assets/{filename}",
                "mime_type": getattr(part, "content_type", "application/octet-stream"),
                "bytes": output_path.stat().st_size,
                "sha256": _sha256(output_path),
            }
            registry[relation_id] = record
            counters["images_extracted"] += 1
        rendered.append(f"![{_escape_inline(_clean_text(alt) or f'图片 {index}')}]({record['markdown_path']})")
    return rendered


def _table_markdown(table: Table) -> str:
    rows: list[list[str]] = []
    for row in table.rows:
        cells = []
        for cell in row.cells:
            text = " / ".join(_clean_text(paragraph.text) for paragraph in cell.paragraphs if _clean_text(paragraph.text))
            cells.append(text.replace("\\", "\\\\").replace("|", "\\|"))
        rows.append(cells)
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    padded = [row + [""] * (width - len(row)) for row in rows]
    lines = ["| " + " | ".join(padded[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
    lines.extend("| " + " | ".join(row) + " |" for row in padded[1:])
    return "\n".join(lines)


def extract_docx(source_path: Path, assets_dir: Path) -> dict[str, Any]:
    source_path = Path(source_path).resolve()
    assets_dir = Path(assets_dir).resolve()
    source_hash_before = _sha256(source_path) if source_path.is_file() else ""
    try:
        with zipfile.ZipFile(source_path) as archive:
            _safe_zip_members(archive)
            names = set(archive.namelist())
            required = {"[Content_Types].xml", "word/document.xml"}
            if not required.issubset(names):
                return _failed("invalid_docx_package:required_parts_missing", source_path)
            document_xml = etree.fromstring(archive.read("word/document.xml"))
            pages = None
            if "docProps/app.xml" in names:
                app_root = etree.fromstring(archive.read("docProps/app.xml"))
                page_nodes = app_root.xpath("//*[local-name()='Pages']/text()")
                if page_nodes and str(page_nodes[0]).isdigit():
                    pages = int(page_nodes[0])
        document = Document(source_path)
    except (OSError, ValueError, zipfile.BadZipFile, etree.XMLSyntaxError) as exc:
        return _failed(f"invalid_docx:{type(exc).__name__}", source_path)

    count = lambda local: len(document_xml.xpath(f"//*[local-name()='{local}']"))
    unsupported = {
        "tracked_insertions": count("ins"),
        "tracked_deletions": count("del"),
        "comments": count("commentRangeStart"),
        "footnote_references": count("footnoteReference"),
        "equations": count("oMath"),
        "text_boxes": count("txbxContent"),
        "alt_chunks": count("altChunk"),
        "charts": count("chart"),
        "embedded_objects": count("OLEObject"),
    }
    table_drawings = len(document_xml.xpath("//*[local-name()='tbl']//*[local-name()='drawing']"))
    if table_drawings:
        unsupported["table_drawings"] = table_drawings
    warnings = [f"unsupported_docx_feature:{name}:{value}" for name, value in unsupported.items() if value]
    if any(name.endswith("vbaProject.bin") for name in names):
        warnings.append("unsupported_docx_feature:macros:1")

    counters = {
        "hyperlinks_total": 0,
        "hyperlinks_external": 0,
        "hyperlinks_internal_plaintext": 0,
        "images_declared": 0,
        "images_extracted": 0,
        "images_missing": 0,
    }
    registry: dict[str, dict[str, Any]] = {}
    anchors: list[dict[str, Any]] = []
    blocks: list[str] = []
    title = _clean_text(document.core_properties.title or "") or source_path.stem
    blocks.append(f"# {_escape_block(title)}")
    paragraphs_total = headings = list_items = tables = paragraphs_extracted = 0
    for block_index, block in enumerate(_iter_blocks(document), start=1):
        anchor = {"kind": "table" if isinstance(block, Table) else "paragraph", "index": block_index, "id": f"docx-block-{block_index:04d}"}
        anchors.append(anchor)
        if isinstance(block, Table):
            tables += 1
            table_markdown = _table_markdown(block)
            if table_markdown:
                blocks.append(table_markdown)
            continue
        paragraphs_total += 1
        text = _paragraph_text(block, counters)
        images = _image_assets(document, block, assets_dir, registry, counters)
        if text:
            if not (paragraphs_extracted == 0 and _clean_text(text) == _clean_text(title)):
                heading = _heading_level(block)
                listing = _list_kind(document, block)
                style_name = (block.style.name if block.style else "").lower()
                if heading:
                    blocks.append(f"{'#' * heading} {_escape_block(text)}")
                    headings += 1
                elif listing:
                    kind, level = listing
                    prefix = "-" if kind == "bullet" else "1."
                    blocks.append(f"{'  ' * level}{prefix} {_escape_block(text)}")
                    list_items += 1
                elif "code" in style_name or "preformatted" in style_name:
                    blocks.append(f"```text\n{text}\n```")
                elif "caption" in style_name:
                    blocks.append(f"*{_escape_inline(text)}*")
                else:
                    blocks.append(_escape_block(text))
            paragraphs_extracted += 1
        blocks.extend(images)

    markdown = "\n\n".join(block for block in blocks if block.strip()).strip() + "\n"
    source_hash_after = _sha256(source_path)
    if source_hash_after != source_hash_before:
        return _failed("source_changed_during_docx_extraction", source_path)
    if len(blocks) <= 1:
        return _failed("docx_contains_no_extractable_body", source_path)
    if counters["images_missing"]:
        warnings.append(f"docx_images_missing:{counters['images_missing']}")
    status = "partial" if warnings else "completed"
    quality = {
        "paragraphs_total": paragraphs_total,
        "paragraphs_extracted": paragraphs_extracted,
        "headings": headings,
        "list_items": list_items,
        "tables": tables,
        "images_declared": counters["images_declared"],
        "images_extracted": counters["images_extracted"],
        "hyperlinks_total": counters["hyperlinks_total"],
        "hyperlinks_external": counters["hyperlinks_external"],
        "hyperlinks_internal_plaintext": counters["hyperlinks_internal_plaintext"],
        "unsupported_objects": sum(unsupported.values()),
        "structure_preserved": status == "completed",
        "clean_markdown": not bool(re.search(r"<!--|<\/?w:|^:{3,}", markdown, re.MULTILINE)),
    }
    return {
        "format": "docx",
        "variant": "office-open-xml",
        "status": status,
        "extractor": f"{EXTRACTOR_NAME}/{EXTRACTOR_VERSION}",
        "markdown": markdown,
        "metadata": {
            "source_filename": source_path.name,
            "source_sha256": source_hash_before,
            "source_sha256_after": source_hash_after,
            "source_unchanged": True,
            "title": title,
            "creator": document.core_properties.author or None,
            "subject": document.core_properties.subject or None,
            "keywords": document.core_properties.keywords or None,
            "language": document.core_properties.language or None,
            "created": _iso(document.core_properties.created),
            "modified": _iso(document.core_properties.modified),
            "application_page_count": pages,
            "block_order": "document_body",
        },
        "quality": quality,
        "warnings": warnings,
        "anchors": anchors,
        "assets": list(registry.values()),
    }
