from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PACKAGE_SCHEMA_VERSION = "progressive-reading.rich-text-package/v1"
REQUEST_SCHEMA_VERSION = "progressive-reading.preprocess.request/v1"
REQUEST_CONTRACT_VERSION = "1.0.0"
EXTRACTOR_VERSION = "rich-text-import/0.5.0"
PROJECT_ROOT = Path(__file__).resolve().parents[3]
SUPPORTED_FORMATS = {
    ".txt": ("txt", "text/plain"),
    ".pdf": ("pdf", "application/pdf"),
    ".epub": ("epub", "application/epub+zip"),
    ".docx": (
        "docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
}
TERMINAL_STATUSES = {"completed", "partial", "ocr_required", "failed"}


class RichTextImportError(RuntimeError):
    """Raised when the source package cannot be built safely."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def file_record(path: Path, root: Path) -> dict[str, Any]:
    return {
        "path": path.relative_to(root).as_posix(),
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def detect_format(source_path: Path) -> tuple[str, str]:
    suffix = source_path.suffix.lower()
    if suffix not in SUPPORTED_FORMATS:
        raise RichTextImportError(f"unsupported_format:{suffix or 'missing_extension'}")
    source_type, expected_mime = SUPPORTED_FORMATS[suffix]
    with source_path.open("rb") as stream:
        header = stream.read(8)
    if source_type == "pdf" and not header.startswith(b"%PDF-"):
        raise RichTextImportError("pdf_signature_mismatch")
    if source_type == "epub" and not header.startswith(b"PK"):
        raise RichTextImportError("epub_signature_mismatch")
    if source_type == "docx" and not header.startswith(b"PK"):
        raise RichTextImportError("docx_signature_mismatch")
    return source_type, expected_mime


def extract_document(
    source_type: str,
    source_path: Path,
    assets_dir: Path,
    *,
    epub_chapter_selection: str = "all",
    epub_spine_index: int | None = None,
    literature_chapter_count: int | None = None,
    mineru_result_dir: Path | None = None,
) -> dict[str, Any]:
    if source_type == "txt":
        from .txt import extract_txt

        return extract_txt(source_path, assets_dir)
    if source_type == "pdf":
        if mineru_result_dir is not None:
            from .mineru_pdf import extract_mineru_pdf

            return extract_mineru_pdf(source_path, assets_dir, mineru_result_dir)
        from .pdf import extract_pdf

        return extract_pdf(source_path, assets_dir)
    if source_type == "epub":
        if literature_chapter_count is not None:
            from .literature import extract_literature_epub

            return extract_literature_epub(
                source_path,
                assets_dir,
                literature_chapter_count,
            )
        from .epub import extract_epub

        return extract_epub(
            source_path,
            assets_dir,
            chapter_selection=epub_chapter_selection,
            spine_index=epub_spine_index,
        )
    if source_type == "docx":
        from .docx import extract_docx

        return extract_docx(source_path, assets_dir)
    raise RichTextImportError(f"unsupported_source_type:{source_type}")


def _normalise_result(result: dict[str, Any], source_type: str) -> dict[str, Any]:
    status = str(result.get("status") or "failed")
    if status not in TERMINAL_STATUSES:
        raise RichTextImportError(f"invalid_extractor_status:{status}")
    if result.get("format") != source_type:
        raise RichTextImportError(
            f"extractor_format_mismatch:expected_{source_type}:received_{result.get('format')}"
        )
    markdown = str(result.get("markdown") or "")
    if status in {"completed", "partial"} and not markdown.strip():
        raise RichTextImportError(f"empty_markdown_for_status:{status}")
    return {
        **result,
        "status": status,
        "markdown": markdown,
        "metadata": dict(result.get("metadata") or {}),
        "quality": dict(result.get("quality") or {}),
        "warnings": [str(item) for item in result.get("warnings") or []],
        "anchors": list(result.get("anchors") or []),
        "assets": list(result.get("assets") or []),
    }


def _normalise_asset_paths(result: dict[str, Any], staging: Path) -> dict[str, Any]:
    assets: list[dict[str, Any]] = []
    for raw_asset in result["assets"]:
        asset = dict(raw_asset)
        written_path = asset.pop("output_path", None)
        legacy_path = asset.pop("path", None)
        written_path = written_path or legacy_path
        if written_path:
            resolved = Path(written_path).resolve()
            if not resolved.is_relative_to(staging):
                raise RichTextImportError(f"asset_outside_package:{resolved}")
            if not resolved.is_file():
                raise RichTextImportError(f"asset_missing_after_extraction:{resolved}")
            asset["package_path"] = resolved.relative_to(staging).as_posix()
        if "markdown_path" not in asset and "package_path" in asset:
            asset["markdown_path"] = asset["package_path"]
        assets.append(asset)
    return {**result, "assets": assets}


def _downstream_request(
    *,
    markdown: str,
    source_type: str,
    source_metadata: dict[str, Any],
    user_instruction: str,
    language: str | None,
    content_profile: str | None,
    include_reading_guide: bool | None = None,
) -> dict[str, Any]:
    metadata = {
        **source_metadata,
        "input_form": "written",
    }
    if language:
        metadata["language"] = language
    if content_profile:
        metadata["content_profile"] = content_profile
    processing_options = {"workflow_mode": "standard"}
    if include_reading_guide is not None:
        processing_options["include_reading_guide"] = include_reading_guide
    return {
        "schema_version": REQUEST_SCHEMA_VERSION,
        "contract_version": REQUEST_CONTRACT_VERSION,
        "material": {"markdown": markdown},
        "source_type": source_type,
        "source_metadata": metadata,
        "user_instruction": user_instruction,
        # New source integrations must enter the maintained workflow router.
        # Profile and language evidence remain in source_metadata so the router
        # can use trusted labels without an unnecessary classification call.
        "processing_options": processing_options,
    }


def build_package(
    source_path: str | os.PathLike[str],
    output_dir: str | os.PathLike[str],
    *,
    user_instruction: str = "",
    language: str | None = None,
    content_profile: str | None = None,
    include_reading_guide: bool | None = None,
    epub_chapter_selection: str = "all",
    epub_spine_index: int | None = None,
    literature_chapter_count: int | None = None,
    mineru_result_dir: str | os.PathLike[str] | None = None,
    allow_whole_book_request: bool = False,
) -> dict[str, Any]:
    """Extract one immutable local source into an auditable raw-material package.

    Existing output directories are never overwritten. Only a completed extraction is
    marked eligible for downstream preprocessing; partial output remains review-only.
    """

    source = Path(source_path).expanduser().resolve()
    output = Path(output_dir).expanduser().resolve()
    if not source.is_file():
        raise RichTextImportError(f"source_not_found:{source}")
    if output.exists():
        raise RichTextImportError(f"output_already_exists:{output}")
    if not output.is_relative_to(PROJECT_ROOT):
        raise RichTextImportError(f"output_outside_project:{output}")

    source_type, mime_type = detect_format(source)
    resolved_mineru_result = (
        Path(mineru_result_dir).expanduser().resolve()
        if mineru_result_dir is not None
        else None
    )
    if resolved_mineru_result is not None and source_type != "pdf":
        raise RichTextImportError("mineru_result_only_applies_to_pdf")
    if source_type != "epub" and (
        epub_chapter_selection != "all"
        or epub_spine_index is not None
        or literature_chapter_count is not None
    ):
        raise RichTextImportError("epub_chapter_selection_only_applies_to_epub")
    if epub_spine_index is not None and epub_spine_index < 1:
        raise RichTextImportError("epub_spine_index_must_be_positive")
    if epub_spine_index is not None and epub_chapter_selection != "all":
        raise RichTextImportError("epub_chapter_selection_is_ambiguous")
    if literature_chapter_count is not None and literature_chapter_count < 1:
        raise RichTextImportError("literature_chapter_count_must_be_positive")
    if literature_chapter_count is not None and (
        epub_spine_index is not None or epub_chapter_selection != "all"
    ):
        raise RichTextImportError("epub_chapter_selection_is_ambiguous")
    source_hash_before = sha256_file(source)
    source_size = source.stat().st_size
    extracted_at = utc_now()
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))

    try:
        source_dir = staging / "source"
        assets_dir = staging / "assets"
        source_dir.mkdir(parents=True)
        assets_dir.mkdir(parents=True)
        source_copy = source_dir / f"original{source.suffix.lower()}"
        shutil.copy2(source, source_copy)
        if sha256_file(source_copy) != source_hash_before:
            raise RichTextImportError("source_copy_hash_mismatch")

        result = _normalise_result(
            extract_document(
                source_type,
                source,
                assets_dir,
                epub_chapter_selection=epub_chapter_selection,
                epub_spine_index=epub_spine_index,
                literature_chapter_count=literature_chapter_count,
                mineru_result_dir=resolved_mineru_result,
            ),
            source_type,
        )
        result = _normalise_asset_paths(result, staging)
        if (source_type == 'epub' and epub_chapter_selection == 'all'
                and epub_spine_index is None and literature_chapter_count is None
                and not allow_whole_book_request):
            from .book_routing import logical_chapter_count
            chapter_count = logical_chapter_count(result['markdown'])
            if chapter_count > 1:
                raise RichTextImportError(
                    f'book_import_requires_book_workflow:logical_chapters={chapter_count}; '
                    r'use D:\Projects\BookSimplifier\Import-Book.ps1; '
                    'default split=chapter, reading_guide=false; '
                    'whole-book-as-one-file requires explicit --allow-whole-book-request'
                )
        source_hash_after = sha256_file(source)
        if source_hash_after != source_hash_before:
            raise RichTextImportError("source_changed_during_extraction")

        markdown_path: str | None = None
        if result["markdown"].strip():
            markdown_path = "raw.md"
            (staging / markdown_path).write_text(result["markdown"], encoding="utf-8")

        extractor = {
            "name": EXTRACTOR_VERSION,
            "format_extractor": result.get("extractor") or f"{source_type}/unknown",
        }
        source_metadata = {
            "file_name": source.name,
            "mime_type": mime_type,
            "format": source_type,
            "source_sha256": source_hash_before,
            "source_bytes": source_size,
            "source_copy": source_copy.relative_to(staging).as_posix(),
            "extracted_at": extracted_at,
            "extractor_version": extractor,
            "extraction_status": result["status"],
            "quality": result["quality"],
            **result["metadata"],
        }
        audit_paths = {}
        if result.get("local_audit"):
            from .pdf_text_audit import write_text_audit
            audit_paths = write_text_audit(result["local_audit"], staging / "pdf-source-audit")
        # Audit evidence is not production input: keep request metadata and its
        # model/cache routing unchanged.
        json_write(staging / "source.json", {**source_metadata, **({"local_audits": audit_paths} if audit_paths else {})})
        json_write(staging / "quality.json", {
            "status": result["status"],
            "quality": result["quality"],
            "warnings": result["warnings"],
            "anchors": result["anchors"],
        })
        extraction_result = {
            "format": source_type,
            "variant": result.get("variant"),
            "status": result["status"],
            "markdown_path": markdown_path,
            "metadata": result["metadata"],
            "quality": result["quality"],
            "warnings": result["warnings"],
            "anchors": result["anchors"],
            "assets": result["assets"],
            "extractor": extractor,
            **({"local_audits": audit_paths} if audit_paths else {}),
        }
        json_write(staging / "extraction-result.json", extraction_result)

        request_path: str | None = None
        if result["status"] in {"completed", "partial"} and literature_chapter_count is None:
            request_path = "request.json"
            request = _downstream_request(
                markdown=result["markdown"],
                source_type=source_type,
                source_metadata=source_metadata,
                user_instruction=user_instruction,
                language=language,
                content_profile=content_profile,
                include_reading_guide=include_reading_guide,
            )
            json_write(staging / request_path, request)

        eligible = result["status"] == "completed" and literature_chapter_count is None
        manifest = {
            "schema_version": PACKAGE_SCHEMA_VERSION,
            "created_at": extracted_at,
            "status": result["status"],
            "source": {
                "format": source_type,
                "file_name": source.name,
                "mime_type": mime_type,
                "sha256": source_hash_before,
                "bytes": source_size,
                "copy_path": source_copy.relative_to(staging).as_posix(),
            },
            "extractor": extractor,
            "markdown_path": markdown_path,
            "quality_path": "quality.json",
            "extraction_result_path": "extraction-result.json",
            "assets": result["assets"],
            "downstream": {
                "request_path": request_path,
                "eligible": eligible,
                "reason": (
                    "completed"
                    if eligible
                    else "literature_direct_publish_only"
                    if literature_chapter_count is not None and result["status"] == "completed"
                    else f"source_status_{result['status']}"
                ),
            },
        }
        files = [
            file_record(path, staging)
            for path in sorted(staging.rglob("*"))
            if path.is_file() and path.name != "manifest.json"
        ]
        manifest["files"] = files
        json_write(staging / "manifest.json", manifest)
        staging.rename(output)
        return {"output_dir": str(output), "manifest": manifest}
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
