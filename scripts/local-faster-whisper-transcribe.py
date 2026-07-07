import argparse
import json
from pathlib import Path

from faster_whisper import WhisperModel


def main():
    parser = argparse.ArgumentParser(description="Local faster-whisper transcription helper.")
    parser.add_argument("audio", help="Audio/video file path.")
    parser.add_argument("--out", required=True, help="Plain text transcript output path.")
    parser.add_argument("--json", dest="json_out", help="Segment JSON output path.")
    parser.add_argument("--model", default="tiny", help="faster-whisper model size or path.")
    parser.add_argument("--language", default="zh", help="Language code, or empty for auto.")
    parser.add_argument("--device", default="cpu", help="cpu or cuda.")
    parser.add_argument("--compute-type", default="int8", help="int8, float16, float32, etc.")
    args = parser.parse_args()

    audio_path = Path(args.audio)
    out_path = Path(args.out)
    json_path = Path(args.json_out) if args.json_out else out_path.with_suffix(".json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.parent.mkdir(parents=True, exist_ok=True)

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    language = args.language.strip() or None
    segments, info = model.transcribe(
        str(audio_path),
        language=language,
        vad_filter=True,
        beam_size=5,
    )

    rows = []
    lines = []
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        rows.append({
            "start": segment.start,
            "end": segment.end,
            "text": text,
        })
        lines.append(text)

    out_path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")
    json_path.write_text(json.dumps({
        "audio": str(audio_path),
        "model": args.model,
        "language": info.language,
        "language_probability": info.language_probability,
        "duration": info.duration,
        "segments": rows,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({
        "audio": str(audio_path),
        "out": str(out_path),
        "json": str(json_path),
        "language": info.language,
        "duration": info.duration,
        "segments": len(rows),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
