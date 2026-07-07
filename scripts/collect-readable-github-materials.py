from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import urllib.parse
import urllib.request
import zipfile


WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
BASE_DIR = WORKSPACE_ROOT / "download" / "实验-清洗"
ARCHIVE_DIR = BASE_DIR / "github-archives"
OUTPUT_DIR = BASE_DIR / "github-readable"
MANIFEST_PATH = OUTPUT_DIR / "READABLE-MATERIALS-MANIFEST.md"

REPOS = [
    ("userElaina", "Open-JLU"),
    ("Geraldxm", "JLU-CS-Courses"),
    ("ChenGeng0102", "JLU"),
    ("JLU-NightsWatch", "JLU-Courses"),
]

READABLE_EXTS = {
    ".md",
    ".markdown",
    ".mdx",
    ".txt",
    ".pdf",
    ".doc",
    ".docx",
    ".ppt",
    ".pptx",
    ".html",
    ".htm",
}

MAX_FILE_BYTES = 200 * 1024 * 1024

SPECIAL_READABLE_NAMES = {"readme", "license", "notice"}


def is_readable_file(path: str) -> bool:
    name = Path(path).name
    stem = Path(path).stem.lower()
    suffix = Path(path).suffix.lower()
    if stem in SPECIAL_READABLE_NAMES:
        return True
    if name.lower().startswith("readme."):
        return True
    return suffix in READABLE_EXTS


def safe_relative_zip_path(name: str) -> Path | None:
    parts = Path(name).parts
    if len(parts) <= 1:
        return None
    relative = Path(*parts[1:])
    if any(part in ("", ".", "..") for part in relative.parts):
        return None
    return relative


def repo_key(owner: str, repo: str) -> str:
    return f"{owner}__{repo}"


def extract_readable_from_archive(owner: str, repo: str) -> dict:
    key = repo_key(owner, repo)
    archive_path = ARCHIVE_DIR / f"{key}.zip"
    target_root = OUTPUT_DIR / key
    result = {
        "repo": f"{owner}/{repo}",
        "source": str(archive_path),
        "method": "zip_extract_readable_only",
        "status": "missing_archive",
        "files": [],
        "error": "",
    }

    if not archive_path.exists():
        return result

    try:
        with zipfile.ZipFile(archive_path) as archive:
            for info in archive.infolist():
                if info.is_dir() or not is_readable_file(info.filename):
                    continue
                if info.file_size > MAX_FILE_BYTES:
                    continue
                relative = safe_relative_zip_path(info.filename)
                if relative is None:
                    continue
                target = target_root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, target.open("wb") as dest:
                    shutil.copyfileobj(source, dest)
                result["files"].append(str(target.relative_to(OUTPUT_DIR)).replace(os.sep, "/"))
        result["status"] = "ok"
    except zipfile.BadZipFile as exc:
        result["status"] = "bad_zip"
        result["error"] = str(exc)
    return result


def api_get_json(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "web-markdown-import-workflow",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def download_url(url: str, target: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "web-markdown-import-workflow"})
    target.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as dest:
        shutil.copyfileobj(response, dest)


def collect_from_github_api(owner: str, repo: str) -> dict:
    key = repo_key(owner, repo)
    target_root = OUTPUT_DIR / key
    result = {
        "repo": f"{owner}/{repo}",
        "source": f"https://github.com/{owner}/{repo}",
        "method": "github_api_readable_only",
        "status": "ok",
        "files": [],
        "error": "",
    }
    try:
        repo_info = api_get_json(f"https://api.github.com/repos/{owner}/{repo}")
        branch = repo_info["default_branch"]
        tree = api_get_json(f"https://api.github.com/repos/{owner}/{repo}/git/trees/{urllib.parse.quote(branch)}?recursive=1")
        for item in tree.get("tree", []):
            if item.get("type") != "blob":
                continue
            source_path = item.get("path", "")
            if not is_readable_file(source_path):
                continue
            if item.get("size", 0) > MAX_FILE_BYTES:
                continue
            raw_path = "/".join(urllib.parse.quote(part) for part in source_path.split("/"))
            raw_url = f"https://raw.githubusercontent.com/{owner}/{repo}/{urllib.parse.quote(branch)}/{raw_path}"
            target = target_root / source_path
            download_url(raw_url, target)
            result["files"].append(str(target.relative_to(OUTPUT_DIR)).replace(os.sep, "/"))
    except Exception as exc:
        result["status"] = "failed"
        result["error"] = repr(exc)
    return result


def write_manifest(results: list[dict]) -> None:
    lines = [
        "# GitHub readable materials manifest",
        "",
        "- Scope: only directly readable files were collected.",
        "- Included extensions: Markdown, TXT, PDF, Word, PowerPoint, HTML.",
        "- Excluded by design: source code, Git history, hidden metadata, build files, archives, images unless embedded in documents.",
        "",
        "## Results",
        "",
    ]
    for result in results:
        lines.extend([
            f"### {result['repo']}",
            "",
            f"- Status: {result['status']}",
            f"- Method: {result['method']}",
            f"- Files: {len(result['files'])}",
        ])
        if result["error"]:
            lines.append(f"- Error: `{result['error']}`")
        if result["files"]:
            lines.append("")
            lines.extend(f"- `{file}`" for file in sorted(result["files"]))
        lines.append("")
    MANIFEST_PATH.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    for owner, repo in REPOS:
        result = extract_readable_from_archive(owner, repo)
        if result["status"] in {"missing_archive", "bad_zip"}:
            result = collect_from_github_api(owner, repo)
        results.append(result)
    write_manifest(results)
    print(json.dumps({
        "output_dir": str(OUTPUT_DIR),
        "manifest": str(MANIFEST_PATH),
        "results": [
            {
                "repo": result["repo"],
                "status": result["status"],
                "method": result["method"],
                "files": len(result["files"]),
                "error": result["error"],
            }
            for result in results
        ],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
