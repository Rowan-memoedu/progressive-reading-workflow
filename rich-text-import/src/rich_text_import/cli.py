from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .core import PROJECT_ROOT, RichTextImportError, build_package


def positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract one PDF, EPUB, DOCX, or TXT into a progressive-reading raw-material package."
    )
    parser.add_argument("source", help="Local .pdf, .epub, .docx, or .txt file. The source is never modified.")
    parser.add_argument("--output", required=True, help="New package directory inside the project workspace.")
    parser.add_argument("--instruction", default="", help="User instruction forwarded unchanged downstream.")
    parser.add_argument("--language", help="Trusted source language label, for example zh, en, or bilingual.")
    parser.add_argument("--no-reading-guide", action="store_true", help="Explicitly disable downstream reading-guide generation.")
    parser.add_argument("--allow-whole-book-request", action="store_true", help="Explicitly bypass book routing only when a whole book is intentionally requested as one reading file.")
    parser.add_argument(
        "--content-profile",
        choices=["natural_language", "math_lecture", "literature"],
        help="Trusted downstream content profile. Omit when unknown.",
    )
    parser.add_argument(
        "--pdf-mineru-result",
        help="Validated item directory produced by the MinerU precision runner for this PDF.",
    )
    epub_scope = parser.add_mutually_exclusive_group()
    epub_scope.add_argument(
        "--epub-chapter",
        choices=["all", "last"],
        default="all",
        help="EPUB body scope. Use 'last' to extract only the final spine chapter.",
    )
    epub_scope.add_argument(
        "--epub-spine-index",
        type=positive_integer,
        help="Extract one EPUB chapter by its 1-based original OPF spine position.",
    )
    epub_scope.add_argument(
        "--epub-literature-first-chapters",
        type=positive_integer,
        help="Select the first N real literary chapters from EPUB TOC targets, including fragment ranges inside one spine item.",
    )
    parser.add_argument(
        "--publish-literature",
        help="Publish a validated literary EPUB directly to a flat 阅读区/Epub/<title>.md target without standard semantic preprocessing.",
    )
    parser.add_argument("--json", action="store_true", help="Emit a machine-readable result.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(list(sys.argv[1:] if argv is None else argv))
    if bool(args.publish_literature) != bool(args.epub_literature_first_chapters):
        print(
            "ERROR: --publish-literature and --epub-literature-first-chapters must be used together",
            file=sys.stderr,
        )
        return 2
    try:
        result = build_package(
            args.source,
            args.output,
            user_instruction=args.instruction,
            language=args.language,
            content_profile=args.content_profile,
            include_reading_guide=False if args.no_reading_guide else None,
            epub_chapter_selection=args.epub_chapter,
            epub_spine_index=args.epub_spine_index,
            literature_chapter_count=args.epub_literature_first_chapters,
            mineru_result_dir=args.pdf_mineru_result,
            allow_whole_book_request=args.allow_whole_book_request,
        )
        publication = None
        if args.publish_literature:
            from .literature import publish_literature_package

            publication = publish_literature_package(
                Path(result["output_dir"]),
                Path(args.publish_literature),
                args.epub_literature_first_chapters,
                PROJECT_ROOT,
            )
            result["literature_publication"] = publication
    except (RichTextImportError, OSError, ValueError) as exc:
        payload = {"ok": False, "error": {"type": type(exc).__name__, "message": str(exc)}}
        print(json.dumps(payload, ensure_ascii=False) if args.json else f"ERROR: {exc}", file=sys.stderr)
        return 1
    payload = {"ok": True, **result}
    print(json.dumps(payload, ensure_ascii=False) if args.json else result["output_dir"])
    if publication is not None and publication.get("status") != "READY":
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
