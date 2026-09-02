from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


def fail(message: str, code: int = 2) -> None:
    sys.stderr.write(message + "\n")
    sys.exit(code)


def load_mono(path: Path, sample_rate: int):
    try:
        import numpy as np
        import soundfile as sf
    except ImportError as exc:
        fail(f"Missing audio dependency: {exc}")
    audio, sr = sf.read(str(path), always_2d=True)
    mono = audio.mean(axis=1)
    if sr != sample_rate:
        try:
            import librosa

            mono = librosa.resample(mono, orig_sr=sr, target_sr=sample_rate)
            sr = sample_rate
        except ImportError:
            pass
    return np.asarray(mono, dtype="float32"), int(sr)


def bpm_confidence(beat_ms: list[float]) -> float:
    if len(beat_ms) < 4:
        return 0.0 if len(beat_ms) < 2 else 0.4
    periods = [beat_ms[i] - beat_ms[i - 1] for i in range(1, len(beat_ms))]
    periods.sort()
    n = len(periods)
    q1 = periods[n // 4]
    q3 = periods[(3 * n) // 4]
    median = periods[n // 2]
    if median <= 0:
        return 0.0
    iqr = max(0.0, q3 - q1)
    return max(0.0, min(1.0, 1.0 - iqr / median))


def beat_this(path: Path, sample_rate: int) -> dict:
    started = time.perf_counter()
    audio, sr = load_mono(path, sample_rate)
    beats = []
    downbeats = []
    try:
        from beat_this.inference import Audio2Beats

        model = Audio2Beats()
        try:
            beats, downbeats = model(audio, sr)
        except TypeError:
            beats, downbeats = model(audio)
    except Exception:
        try:
            from beat_this.inference import File2Beats
        except ImportError:
            try:
                from beat_this import File2Beats  # type: ignore
            except ImportError as exc:
                fail(f"beat-this is not installed: {exc}", 3)
        model = File2Beats()
        beats, downbeats = model(str(path))
    beat_ms = [float(t) * 1000.0 for t in beats]
    down_ms = [float(t) * 1000.0 for t in downbeats]
    bpm = None
    if len(beat_ms) >= 2:
        periods = [beat_ms[i] - beat_ms[i - 1] for i in range(1, len(beat_ms))]
        median = sorted(periods)[len(periods) // 2]
        if median > 0:
            bpm = 60000.0 / median
            if bpm < 120:
                bpm *= 2
    confidence = bpm_confidence(beat_ms)
    return {
        "analyzerName": "beat-this",
        "analyzerVersion": "sidecar",
        "bpm": bpm,
        "bpmConfidence": confidence if bpm else 0.0,
        "bpmRaw": bpm,
        "beatTimesMs": beat_ms,
        "downbeatTimesMs": down_ms,
        "gridRejected": bpm is None,
        "gridRejectionReason": None if bpm else "beat-this returned no tempo",
        "sections": [],
        "engineRuntimeMs": int((time.perf_counter() - started) * 1000),
    }


def allin1(path: Path) -> dict:
    started = time.perf_counter()
    result = None
    try:
        import allin1 as allin1_mod

        result = allin1_mod.analyze(str(path))
    except Exception:
        try:
            import allin1_infer

            result = allin1_infer.analyze(str(path))
        except ImportError as exc:
            fail(f"all-in-one is not installed: {exc}", 3)
    bpm = float(getattr(result, "bpm", 0) or 0) or None
    beats = [float(t) * 1000.0 for t in getattr(result, "beats", [])]
    downbeats = [float(t) * 1000.0 for t in getattr(result, "downbeats", [])]
    sections = []
    for seg in getattr(result, "segments", []) or []:
        label = str(getattr(seg, "label", getattr(seg, "function", "build"))).lower()
        mapping = {
            "intro": "intro",
            "verse": "build",
            "chorus": "drop",
            "drop": "drop",
            "bridge": "bridge",
            "inst": "build",
            "outro": "outro",
            "break": "breakdown",
            "breakdown": "breakdown",
        }
        start = float(getattr(seg, "start", 0)) * 1000.0
        end = float(getattr(seg, "end", start)) * 1000.0
        sections.append(
            {
                "type": mapping.get(label, "build"),
                "startMs": start,
                "endMs": end,
                "startBar": None,
                "endBar": None,
                "confidence": 0.6,
                "sectionEnergy": 0.5,
            }
        )
    if bpm and bpm < 120:
        bpm *= 2
    return {
        "analyzerName": "allin1",
        "analyzerVersion": "sidecar",
        "bpm": bpm,
        "bpmConfidence": bpm_confidence(beats) if bpm else 0.0,
        "bpmRaw": bpm,
        "beatTimesMs": beats,
        "downbeatTimesMs": downbeats,
        "gridRejected": bpm is None,
        "gridRejectionReason": None if bpm else "allin1 returned no tempo",
        "sections": sections,
        "engineRuntimeMs": int((time.perf_counter() - started) * 1000),
    }


def analyze_one(engine: str, path: Path, sample_rate: int) -> dict:
    if engine == "beat-this":
        return beat_this(path, sample_rate)
    return allin1(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="dnb-crate optional Python analysis sidecar")
    parser.add_argument("--engine", choices=["beat-this", "allin1"], required=True)
    parser.add_argument("--input", action="append", required=True)
    parser.add_argument("--sample-rate", type=int, default=22050)
    args = parser.parse_args()
    for raw in args.input:
        path = Path(raw)
        if not path.is_file():
            fail(f"Input file not found: {path}")
        payload = analyze_one(args.engine, path, args.sample_rate)
        sys.stdout.write(json.dumps(payload))
        sys.stdout.write("\n")


if __name__ == "__main__":
    main()
