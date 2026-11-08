"""Deterministic literary-EPUB selection and flat reading-area publication."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .epub import extract_epub


LITERATURE_PROFILE = "literature_epub/v1"
_CHAPTER_LABEL = re.compile(
    r"^(?:"
    r"chapter|chap\.?|chapitre|cap[ií]tulo|capitolo|kapitel|глава"
    r")\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b"
    r"|^第[^\s]{1,16}[章回节](?:\s|$)",
    re.IGNORECASE,
)
_STRUCTURAL_LABEL = re.compile(
    r"^(?:part|book|volume)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b"
    r"|^第[^\s]{1,16}[部卷](?:\s|$)",
    re.IGNORECASE,
)
_ANCHOR_TAG = re.compile(r'<a id="([^"]+)"></a>\s*')
_INVISIBLE_CONTROL = re.compile(
    "[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]"
)
_SCAFFOLD_HEADINGS = re.compile(
    r"(?im)^#{1,6}\s*(?:阅读前置卡|导读卡|核心观点|核心洞见|难度分级|摘要|summary)\s*$"
)
_PANDOC_RESIDUE = re.compile(r"(?m)^\s*:::+|\{(?:#|\.|[A-Za-z][\w-]*=)")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_chapter(entry: dict[str, Any]) -> bool:
    return bool(_CHAPTER_LABEL.search(" ".join(str(entry.get("label") or "").split())))


def _is_structure(entry: dict[str, Any]) -> bool:
    return bool(_STRUCTURAL_LABEL.search(" ".join(str(entry.get("label") or "").split())))


def _marker(entry: dict[str, Any]) -> str | None:
    anchor = entry.get("target_anchor")
    return f'<a id="{anchor}"></a>' if anchor else None


def _remove_unreferenced_anchors(markdown: str) -> tuple[str, set[str]]:
    referenced = set(re.findall(r"\]\(#([^)]+)\)", markdown))
    replacements: dict[str, str] = {}
    used: set[str] = set()
    for anchor in sorted(referenced):
        source_fragment = anchor.split("--", 1)[-1]
        source_fragment = re.sub(r"[^A-Za-z0-9_.:-]+", "-", source_fragment).strip("-")
        candidate = f"source-{source_fragment or hashlib.sha256(anchor.encode('utf-8')).hexdigest()[:12]}"
        unique = candidate
        suffix = 2
        while unique in used:
            unique = f"{candidate}-{suffix}"
            suffix += 1
        replacements[anchor] = unique
        used.add(unique)

    def replace(match: re.Match[str]) -> str:
        anchor = match.group(1)
        return f'<a id="{replacements[anchor]}"></a>\n' if anchor in referenced else ""

    cleaned = _ANCHOR_TAG.sub(replace, markdown)
    for old, new in replacements.items():
        cleaned = cleaned.replace(f"](#{old})", f"](#{new})")
    return cleaned, set(replacements.values())


def _clean_markdown(markdown: str) -> tuple[str, list[str]]:
    changes: list[str] = []
    without_comments = re.sub(r"<!--[\s\S]*?-->", "", markdown)
    if without_comments != markdown:
        changes.append("html_comments_removed")
    without_controls = _INVISIBLE_CONTROL.sub("", without_comments)
    if without_controls != without_comments:
        changes.append("invisible_controls_removed")
    without_unused_anchors, _ = _remove_unreferenced_anchors(without_controls)
    if without_unused_anchors != without_controls:
        changes.append("unreferenced_generated_anchors_removed")
    collapsed = re.sub(r"\n{3,}", "\n\n", without_unused_anchors).strip() + "\n"
    return collapsed, changes


def _failed_from(base: dict[str, Any], message: str) -> dict[str, Any]:
    for asset in base.get("assets") or []:
        output_path = asset.get("output_path")
        if output_path:
            Path(output_path).unlink(missing_ok=True)
    return {
        **base,
        "status": "failed",
        "markdown": "",
        "assets": [],
        "warnings": [*(base.get("warnings") or []), message],
        "metadata": {
            **(base.get("metadata") or {}),
            "content_profile": LITERATURE_PROFILE,
            "literature_selection_status": "failed",
        },
        "quality": {
            **(base.get("quality") or {}),
            "selection_mode": "literature_first_chapters",
            "logical_chapters_extracted": 0,
            "structure_preserved": False,
        },
    }


def extract_literature_epub(
    source_path: Path,
    assets_dir: Path,
    chapter_count: int,
) -> dict[str, Any]:
    """Select the first N real chapters using EPUB TOC targets, not spine count."""

    if chapter_count < 1:
        raise ValueError("literature chapter count must be positive")
    base = extract_epub(source_path, assets_dir)
    if base.get("status") == "failed":
        return base

    toc = list((base.get("metadata") or {}).get("toc") or [])
    chapter_entries = [entry for entry in toc if _is_chapter(entry)]
    if len(chapter_entries) < chapter_count:
        return _failed_from(
            base,
            f"literature TOC has only {len(chapter_entries)} identifiable chapters; requested {chapter_count}",
        )

    selected = chapter_entries[:chapter_count]
    if any(not _marker(entry) for entry in selected):
        return _failed_from(base, "selected literature chapter lacks a resolvable TOC target anchor")

    first_index = toc.index(selected[0])
    prefix: dict[str, Any] | None = None
    for candidate in reversed(toc[:first_index]):
        if candidate.get("source_path") != selected[0].get("source_path"):
            break
        if _is_structure(candidate) and _marker(candidate):
            prefix = candidate
            break
        if _is_chapter(candidate):
            break

    source_markdown = str(base.get("markdown") or "")
    pieces: list[str] = []
    evidence: list[dict[str, Any]] = []
    for index, entry in enumerate(selected):
        start_entry = prefix if index == 0 and prefix else entry
        start_marker = _marker(start_entry)
        if not start_marker:
            return _failed_from(base, "literature chapter start marker is missing")
        start = source_markdown.find(start_marker)
        if start < 0:
            return _failed_from(base, f"literature chapter marker not found in Markdown: {entry.get('label')!r}")

        chapter_position = chapter_entries.index(entry)
        next_entry = (
            chapter_entries[chapter_position + 1]
            if chapter_position + 1 < len(chapter_entries)
            else None
        )
        end = len(source_markdown)
        if next_entry is not None:
            next_marker = _marker(next_entry)
            if not next_marker:
                return _failed_from(base, "next literature chapter lacks a resolvable TOC target anchor")
            end = source_markdown.find(next_marker, start + len(start_marker))
            if end < 0:
                return _failed_from(base, f"next literature chapter marker not found: {next_entry.get('label')!r}")
        if end <= start:
            return _failed_from(base, f"invalid literature chapter range: {entry.get('label')!r}")
        pieces.append(source_markdown[start:end].strip())
        evidence.append(
            {
                "ordinal": index + 1,
                "label": entry.get("label"),
                "source_path": entry.get("source_path"),
                "fragment": entry.get("fragment"),
                "toc_depth": entry.get("depth"),
                "toc_play_order": entry.get("play_order"),
                "target_anchor": entry.get("target_anchor"),
            }
        )

    selected_markdown, cleanup = _clean_markdown("\n\n".join(pieces))
    selected_asset_paths = {
        str(asset.get("markdown_path"))
        for asset in base.get("assets") or []
        if asset.get("markdown_path") and str(asset.get("markdown_path")) in selected_markdown
    }
    selected_assets: list[dict[str, Any]] = []
    for asset in base.get("assets") or []:
        if asset.get("markdown_path") in selected_asset_paths:
            selected_assets.append(asset)
        else:
            output_path = asset.get("output_path")
            if output_path:
                Path(output_path).unlink(missing_ok=True)

    retained_anchor_ids = set(_ANCHOR_TAG.findall(selected_markdown))
    selected_anchors = [
        anchor for anchor in base.get("anchors") or [] if anchor.get("id") in retained_anchor_ids
    ]
    metadata = {
        **(base.get("metadata") or {}),
        "content_profile": LITERATURE_PROFILE,
        "chapter_selection": "literature_first_chapters",
        "requested_literature_chapters": chapter_count,
        "literature_selection_status": "selected",
        "literature_chapters": evidence,
        "literature_context_prefix": (
            {
                "label": prefix.get("label"),
                "source_path": prefix.get("source_path"),
                "fragment": prefix.get("fragment"),
            }
            if prefix
            else None
        ),
        "toc": selected,
        "deterministic_cleanup": cleanup,
        "semantic_transform_applied": False,
    }
    quality = {
        **(base.get("quality") or {}),
        "selection_mode": "literature_first_chapters",
        "selected_spine_items": len({entry.get("source_path") for entry in selected}),
        "chapters_extracted": chapter_count,
        "logical_chapters_extracted": chapter_count,
        "toc_entries": chapter_count,
        "images_selected": len(selected_assets),
        "images_extracted": len(selected_assets),
        "structure_preserved": base.get("status") == "completed",
    }
    return {
        **base,
        "markdown": selected_markdown,
        "metadata": metadata,
        "quality": quality,
        "anchors": selected_anchors,
        "assets": selected_assets,
    }


def validate_literature_package(
    package_dir: Path,
    publish_path: Path,
    expected_chapters: int,
    project_root: Path,
) -> dict[str, Any]:
    package_dir = package_dir.resolve()
    publish_path = publish_path.resolve()
    project_root = project_root.resolve()
    source = json.loads((package_dir / "source.json").read_text(encoding="utf-8"))
    extraction = json.loads((package_dir / "extraction-result.json").read_text(encoding="utf-8"))
    markdown = (package_dir / "raw.md").read_text(encoding="utf-8")
    source_copy = package_dir / source["source_copy"]
    reading_root = (project_root / "阅读区").resolve()
    epub_root = (reading_root / "Epub").resolve()
    headings = re.findall(r"(?m)^#{1,6}\s+(.+?)\s*$", markdown)
    chapter_headings = [heading for heading in headings if _CHAPTER_LABEL.search(heading)]
    source_hash = str(source.get("source_sha256") or "").lower()
    checks = {
        "source_copy_hash_matches": _sha256(source_copy) == source_hash,
        "exact_logical_chapter_count": (
            extraction.get("quality", {}).get("logical_chapters_extracted") == expected_chapters
            and len(extraction.get("metadata", {}).get("literature_chapters") or []) == expected_chapters
            and len(chapter_headings) == expected_chapters
        ),
        "deterministic_no_semantic_transform": extraction.get("metadata", {}).get("semantic_transform_applied") is False,
        "no_generated_scaffolding": not _SCAFFOLD_HEADINGS.search(markdown),
        "no_epub_html_pandoc_residue": not (
            "<!--" in markdown
            or re.search(r"</?(?:html|head|body|div|span|p|section|article)(?:\s|>)", markdown, re.I)
            or _PANDOC_RESIDUE.search(markdown)
        ),
        "no_temporary_chapter_anchors": "epub-chapter-" not in markdown,
        "no_invisible_controls": not _INVISIBLE_CONTROL.search(markdown),
        "flat_reading_area_target": (
            publish_path.suffix.lower() == ".md"
            and publish_path.name.lower() != "reading.md"
            and publish_path.parent == epub_root
            and publish_path.is_relative_to(reading_root)
        ),
        "extraction_completed": extraction.get("status") == "completed",
    }
    return {
        "schema_version": "progressive-reading.literature-epub-validation/v1",
        "profile": LITERATURE_PROFILE,
        "status": "READY" if all(checks.values()) else "FAILED",
        "checks": checks,
        "source_sha256": source_hash,
        "source_copy_sha256": _sha256(source_copy),
        "markdown_sha256": _sha256(package_dir / "raw.md"),
        "chapter_headings": chapter_headings,
        "chapter_evidence": extraction.get("metadata", {}).get("literature_chapters") or [],
        "context_prefix": extraction.get("metadata", {}).get("literature_context_prefix"),
        "publish_path": str(publish_path),
    }


def publish_literature_package(
    package_dir: Path,
    publish_path: Path,
    expected_chapters: int,
    project_root: Path,
) -> dict[str, Any]:
    package_dir = package_dir.resolve()
    publish_path = publish_path.resolve()
    report = validate_literature_package(
        package_dir, publish_path, expected_chapters, project_root
    )
    report_path = package_dir / "literature-validation.json"
    if report["status"] != "READY":
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return report
    if publish_path.exists():
        report["status"] = "FAILED"
        report["checks"]["target_does_not_exist"] = False
        report["failure"] = "publish target already exists; no overwrite attempted"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return report

    publish_path.parent.mkdir(parents=True, exist_ok=True)
    original_markdown = (package_dir / "raw.md").read_bytes().decode("utf-8")
    converter_path = Path(__file__).resolve().parents[3] / "standard-preprocessing" / "chinese-script-cli.mjs"
    converted = subprocess.run(
        [shutil.which("node") or "node", str(converter_path)],
        input=json.dumps({"markdown": original_markdown}, ensure_ascii=False),
        text=True, encoding="utf-8", capture_output=True, check=True, timeout=60,
    )
    projection = json.loads(converted.stdout)
    markdown_bytes = projection["markdown"].encode("utf-8")
    report["chinese_script"] = projection["report"]
    report["publication_projection_sha256"] = hashlib.sha256(markdown_bytes).hexdigest()
    handle, temporary_name = tempfile.mkstemp(
        prefix=f".{publish_path.stem}.", suffix=".tmp", dir=publish_path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(markdown_bytes)
        temporary.rename(publish_path)
    finally:
        temporary.unlink(missing_ok=True)

    report["publication_status"] = "published"
    report["published_sha256"] = _sha256(publish_path)
    report["checks"]["published_hash_matches"] = report["published_sha256"] == report["publication_projection_sha256"]
    if not report["checks"]["published_hash_matches"]:
        report["status"] = "FAILED"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report
