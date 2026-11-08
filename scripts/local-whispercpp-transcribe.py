from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


DATA_ROOT = Path(os.environ.get("AUDIO_WORKFLOW_V2_DATA_ROOT", r"D:\AudioWorkflow\v2"))
DEFAULT_MODEL = DATA_ROOT / "models" / "ggml-tiny.bin"
SOURCE_RELEASE_DIR = DATA_ROOT / "tools" / "whisper.cpp" / "Release"
RUNTIME_DIR = Path(os.environ.get("AUDIO_WORKFLOW_V2_RUNTIME", r"D:\AudioWorkflow\runtime"))
RUNTIME_RELEASE_DIR = RUNTIME_DIR / "whisper_release"
RUNTIME_MODEL_DIR = RUNTIME_DIR / "models"
RUNTIME_TASK_DIR = RUNTIME_DIR / "progressive_reading"


def run(args: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
        # Child console programs must stay silent even when Python has no console.
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()
        raise RuntimeError(detail or f"command failed: {' '.join(args)}")
    return proc


def prepare_runtime(model: Path) -> tuple[Path, Path, Path]:
    runtime_cli = RUNTIME_RELEASE_DIR / "whisper-cli.exe"
    if not runtime_cli.exists():
        if not SOURCE_RELEASE_DIR.exists():
            raise RuntimeError(f"missing whisper.cpp release dir: {SOURCE_RELEASE_DIR}")
        RUNTIME_RELEASE_DIR.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(SOURCE_RELEASE_DIR, RUNTIME_RELEASE_DIR, dirs_exist_ok=True)

    if not model.exists():
        raise RuntimeError(f"missing whisper model: {model}")

    RUNTIME_MODEL_DIR.mkdir(parents=True, exist_ok=True)
    runtime_model = RUNTIME_MODEL_DIR / model.name
    if not runtime_model.exists() or runtime_model.stat().st_size != model.stat().st_size:
        shutil.copy2(model, runtime_model)

    return runtime_cli, runtime_model, RUNTIME_RELEASE_DIR


def split_audio(audio: Path, chunks_dir: Path, chunk_seconds: int) -> list[Path]:
    chunks_dir.mkdir(parents=True, exist_ok=True)
    for old in chunks_dir.glob("chunk_*.wav"):
        old.unlink(missing_ok=True)
    pattern = chunks_dir / "chunk_%04d.wav"
    run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(audio),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "segment",
            "-segment_time",
            str(chunk_seconds),
            "-c:a",
            "pcm_s16le",
            str(pattern),
        ]
    )
    chunks = sorted(chunks_dir.glob("chunk_*.wav"))
    if not chunks:
        raise RuntimeError("ffmpeg produced no chunks")
    return chunks


def transcribe_chunk(
    cli: Path,
    model: Path,
    runtime_cwd: Path,
    chunk: Path,
    out_prefix: Path,
    language: str,
    threads: int,
) -> str:
    run(
        [
            str(cli),
            "-m",
            str(model),
            "-f",
            str(chunk),
            "-l",
            language,
            "-t",
            str(threads),
            "-bs",
            "1",
            "-bo",
            "1",
            "-nt",
            "-otxt",
            "-of",
            str(out_prefix),
            "-np",
        ],
        cwd=runtime_cwd,
    )
    txt_path = out_prefix.with_suffix(".txt")
    return txt_path.read_text(encoding="utf-8", errors="ignore").strip() if txt_path.exists() else ""


def main() -> int:
    parser = argparse.ArgumentParser(description="Local whisper.cpp chunked transcription helper.")
    parser.add_argument("audio")
    parser.add_argument("--out", required=True)
    parser.add_argument("--json", dest="json_out")
    parser.add_argument("--model", default=str(DEFAULT_MODEL))
    parser.add_argument("--language", default="zh")
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--chunk-seconds", type=int, default=45)
    parser.add_argument("--work-name", default="")
    parser.add_argument("--keep-chunks", action="store_true")
    args = parser.parse_args()

    audio = Path(args.audio)
    if not audio.exists():
        raise FileNotFoundError(audio)

    safe_name = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in (args.work_name or audio.stem))[:80]
    task_dir = RUNTIME_TASK_DIR / safe_name
    if task_dir.exists():
        shutil.rmtree(task_dir, ignore_errors=True)
    chunks_dir = task_dir / "chunks"
    texts_dir = task_dir / "texts"
    texts_dir.mkdir(parents=True, exist_ok=True)

    cli, model, runtime_cwd = prepare_runtime(Path(args.model))
    chunks = split_audio(audio, chunks_dir, args.chunk_seconds)
    segments: list[dict] = []
    for index, chunk in enumerate(chunks):
        out_prefix = texts_dir / f"{index:04d}"
        text = transcribe_chunk(cli, model, runtime_cwd, chunk, out_prefix, args.language, args.threads)
        segments.append({"chunk": index, "text": text})
        if not args.keep_chunks:
            chunk.unlink(missing_ok=True)

    transcript = "\n".join(item["text"] for item in segments if item["text"]).strip()
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(transcript, encoding="utf-8")
    if args.json_out:
        Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json_out).write_text(
            json.dumps(
                {
                    "source": str(audio),
                    "backend": "whisper.cpp",
                    "model": str(model),
                    "language": args.language,
                    "chunk_seconds": args.chunk_seconds,
                    "text": transcript,
                    "chunks": segments,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    if not args.keep_chunks:
        shutil.rmtree(task_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
