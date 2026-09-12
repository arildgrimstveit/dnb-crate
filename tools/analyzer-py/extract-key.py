"""Optional Essentia KeyExtractor. Not essentia.js. Used only by the cohort compare script."""
from __future__ import annotations

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    args = parser.parse_args()
    try:
        import essentia.standard as es
    except ImportError:
        print(json.dumps({"error": "essentia not installed"}), file=sys.stderr)
        return 2
    loader = es.MonoLoader(filename=args.input)
    audio = loader()
    key, scale, strength = es.KeyExtractor()(audio)
    musical = f"{key}m" if scale == "minor" else key
    print(json.dumps({"musicalKey": musical, "keyConfidence": float(strength), "scale": scale}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
