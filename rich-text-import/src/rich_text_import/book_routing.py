"""Recognize explicit logical chapters; EPUB spine file count is not a book boundary."""
import re


def logical_chapter_count(markdown: str) -> int:
    chapter = re.compile(r"^(?:chapter\s+(?:\d+|[ivxlcdm]+)\b|第\s*[一二三四五六七八九十百零〇两0-9０-９]+\s*章)", re.I)
    count, fence = 0, None
    for line in markdown.splitlines():
        marker = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
        if marker:
            if fence is None:
                fence = marker[1][0]
            elif fence == marker[1][0]:
                fence = None
            continue
        heading = re.match(r"^#{1,6}\s+(.+)", line) if fence is None else None
        if heading and chapter.match(heading[1]):
            count += 1
    return count
