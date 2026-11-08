"""Fetch pinned public upstream code or a published subtitle package, never video."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess

REPO = "Luke-Evan/videobook"
CODE_COMMIT = "95d102de80c2a3cca7da20f744cb5e82e81c3bdc"
PAGES_COMMIT = "9fbf21e3e275700b949e65d732afb6699ca4f7f1"


def api(endpoint):
    import base64
    response = subprocess.run(["gh", "api", f"repos/{REPO}/{endpoint}"],
                              check=True, capture_output=True, encoding="utf-8")
    value = json.loads(response.stdout)
    if "content" in value:
        data = base64.b64decode(value["content"])
        actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if actual != value["sha"]:
            raise ValueError("Git blob hash mismatch")
        return data
    return value


def save_exact(target, data):
    if target.exists() and target.read_bytes() != data:
        raise ValueError(f"Refusing to overwrite different content: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        target.write_bytes(data)


def fetch_tree(commit, target, prefix=""):
    tree = api(f"git/trees/{commit}?recursive=1")
    if tree.get("truncated"):
        raise ValueError("Truncated GitHub tree")
    entries = [e for e in tree["tree"] if e["type"] == "blob" and e["path"].startswith(prefix)]
    if not entries:
        raise ValueError("Empty source package")

    def fetch(entry):
        relative = entry["path"][len(prefix):]
        destination = (target / relative).resolve()
        if not destination.is_relative_to(target.resolve()) or entry.get("mode") != "100644":
            raise ValueError(f"Unsafe tree entry: {entry['path']}")
        data = api(f"git/blobs/{entry['sha']}")
        save_exact(destination, data)
        print(f"fetched {relative} ({len(data)} bytes)", flush=True)
        return {"path": relative, "bytes": len(data), "git_blob": entry["sha"],
                "sha256": hashlib.sha256(data).hexdigest()}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        files = list(pool.map(fetch, entries))
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["code", "sample"])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--video-id", default="BV1CQt365EzW")
    parser.add_argument("--pages-commit", default=PAGES_COMMIT,
                        help="Exact pages commit for newly published packages; existing default stays pinned")
    args = parser.parse_args()
    if len(args.pages_commit)!=40 or any(c not in '0123456789abcdef' for c in args.pages_commit):
        parser.error('--pages-commit must be an exact Git commit')
    if args.mode == "code":
        target = args.output or Path(__file__).parent / "upstream"
        files = fetch_tree(CODE_COMMIT, target)
        lock = {"repository": f"https://github.com/{REPO}", "commit": CODE_COMMIT,
                "license": "Apache-2.0", "files": files}
        save_exact(target.parent / "upstream-lock.json", (json.dumps(lock, ensure_ascii=False, indent=2) + "\n").encode())
    else:
        if not args.output:
            parser.error("sample requires --output outside the source repository")
        manifest = json.loads(api(f"contents/manifest.json?ref={args.pages_commit}"))
        entry = manifest[args.video_id]
        files = fetch_tree(args.pages_commit, args.output, entry["folder"] + "/")
        source = {"source_url": f"https://www.bilibili.com/video/{args.video_id}/",
                  "canonical_url": f"https://www.bilibili.com/video/{args.video_id}/",
                  "title": entry["title"].split(" [")[0], "source_id": args.video_id,
                  "author": "蒋炎岩", "language": "zh", "input_form": "spoken_transcript",
                  "source_platform": "Bilibili", "source_is_original": True,
                  "subtitle_kind": "upstream_corrected", "subtitle_file": "transcript.corrected.txt",
                  "upstream_repository": f"https://github.com/{REPO}", "upstream_commit": args.pages_commit,
                  "upstream_folder": entry["folder"], "media_downloaded": False, "asr_used": False,
                  "files": files}
        save_exact(args.output / "source.json", (json.dumps(source, ensure_ascii=False, indent=2) + "\n").encode())
    print("verified public files fetched", flush=True)


if __name__ == "__main__":
    main()
