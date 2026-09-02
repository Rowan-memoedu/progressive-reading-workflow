from __future__ import annotations

import argparse
import json
import sys

from .core import RichTextImportError, build_package


def positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract one text PDF, EPUB, or DOCX into a progressive-reading raw-material package."
    )
    parser.add_argument("source", help="Local .pdf, .epub, or .docx file. The source is never modified.")
    parser.add_argument("--output", required=True, help="New package directory inside the project workspace.")
    parser.add_argument("--instruction", default="", help="User instruction forwarded unchanged downstream.")
    parser.add_argument("--language", help="Trusted source language label, for example zh, en, or bilingual.")
    parser.add_argument(
        "--content-profile",
        choices=["natural_language", "math_lecture"],
        help="Trusted downstream content profile. Omit when unknown.",
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
    parser.add_argument("--json", action="store_true", help="Emit a machine-readable result.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(list(sys.argv[1:] if argv is None else argv))
    try:
        result = build_package(
            args.source,
            args.output,
            user_instruction=args.instruction,
            language=args.language,
            content_profile=args.content_profile,
            epub_chapter_selection=args.epub_chapter,
            epub_spine_index=args.epub_spine_index,
        )
    except (RichTextImportError, OSError, ValueError) as exc:
        payload = {"ok": False, "error": {"type": type(exc).__name__, "message": str(exc)}}
        print(json.dumps(payload, ensure_ascii=False) if args.json else f"ERROR: {exc}", file=sys.stderr)
        return 1
    payload = {"ok": True, **result}
    print(json.dumps(payload, ensure_ascii=False) if args.json else result["output_dir"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
