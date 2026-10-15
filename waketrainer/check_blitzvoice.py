"""Check that a trained model fits BlitzVoice's wake word pipeline.

Mirrors wakeword/catalog.rs (input [1,N,96] float32 or dynamic batch, output [1,1]
float32, one input and one output) and wakeword/engine.rs (the streaming pipeline
with the melspectrogram.onnx and embedding_model.onnx from BlitzVoice's own
_deps folder). Prints one JSON object. Reads BlitzVoice files, writes nothing there.

    python check_blitzvoice.py --model models\\hey_mission_control.onnx
           [--phrase "hey mission control"] [--wav extra.wav ...]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("ESPEAK_DATA_PATH", str(ROOT / "tools" / "espeak-ng"))
os.environ["PATH"] = str(ROOT / "tools" / "espeak-ng") + os.pathsep + os.environ.get("PATH", "")
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402

from stream_pipeline import StreamEngine, default_feature_dir, read_wav_16k_mono  # noqa: E402


def catalog_check(path: Path):
    s = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    ins, outs = s.get_inputs(), s.get_outputs()
    if len(ins) != 1 or len(outs) != 1:
        return False, f"expected 1 input and 1 output, found {len(ins)} and {len(outs)}"
    i, o = ins[0], outs[0]
    batch_ok = lambda d: d == 1 or isinstance(d, str) or d is None or d == -1  # noqa: E731
    if i.type != "tensor(float)" or len(i.shape) != 3 or not batch_ok(i.shape[0]) \
            or not isinstance(i.shape[1], int) or i.shape[1] <= 0 or i.shape[2] != 96:
        return False, f"input must be float32 [1, N, 96], found {i.type} {i.shape}"
    if o.type != "tensor(float)" or len(o.shape) != 2 or not batch_ok(o.shape[0]) or o.shape[1] != 1:
        return False, f"output must be float32 [1, 1], found {o.type} {o.shape}"
    return True, {"input": [i.name, i.shape, i.type], "output": [o.name, o.shape, o.type], "window": i.shape[1]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--phrase", default="hey mission control")
    ap.add_argument("--negatives", default="what is the weather today,hey vision control,mission control")
    ap.add_argument("--wav", nargs="*", default=[])
    ap.add_argument("--n", type=int, default=12, help="voices per phrase")
    ap.add_argument("--blitzvoice", default=os.environ.get("BLITZVOICE_REPO", ""),
                    help="BlitzVoice source folder, for its test clips (optional)")
    args = ap.parse_args()

    model = Path(args.model)
    ok, detail = catalog_check(model)
    result = {"model": str(model), "catalog_accepts": ok, "catalog_detail": detail,
              "feature_models": str(default_feature_dir())}
    if not ok:
        print(json.dumps(result, indent=2))
        return 1

    engine = StreamEngine(model)

    # Fresh synthetic speech from the trainer's own TTS (voices the model has not seen).
    from livekit.wakeword.config import WakeWordConfig
    from livekit.wakeword.data.tts.piper_backend import PiperVitsBackend

    cfg = WakeWordConfig(model_name="check", target_phrases=[args.phrase], data_dir=str(ROOT / "data"))
    backend = PiperVitsBackend.from_config(cfg)
    work = Path(tempfile.mkdtemp(prefix="check_", dir=str(ROOT / "tmp")))

    def synth(text, tag):
        d = work / tag
        files = backend.synthesize_clips([text], d, 500000 + args.n, start_index=500000, batch_size=args.n)
        return [float(max(engine.score_audio(read_wav_16k_mono(f)))) for f in files]

    pos = synth(args.phrase, "pos")
    result["positive"] = {"phrase": args.phrase, "peaks": [round(x, 3) for x in pos],
                          "min": round(min(pos), 3), "median": round(float(np.median(pos)), 3)}
    result["negatives"] = {}
    for k, t in enumerate([x.strip() for x in args.negatives.split(",") if x.strip()]):
        p = synth(t, f"neg{k}")
        result["negatives"][t] = {"max": round(max(p), 3), "median": round(float(np.median(p)), 3)}
    rng = np.random.default_rng(7)
    result["silence_and_noise"] = {
        "silence": round(float(max(engine.score_audio(np.zeros(48000, np.float32)))), 4),
        "room_noise": round(float(max(engine.score_audio((rng.standard_normal(48000) * 0.003).astype(np.float32)))), 4),
        "loud_noise": round(float(max(engine.score_audio((rng.standard_normal(48000) * 0.1).astype(np.float32)))), 4),
    }
    # A real recording of someone else saying other words: BlitzVoice's own test clips.
    td = Path(args.blitzvoice) / "src-tauri" / "src" / "wakeword" / "testdata" if args.blitzvoice else None
    other = {}
    for w in ["hey_jane.wav", "hey_jarvis_kokoro.wav", "hey_mycroft_test.wav", "alexa_test.wav"]:
        if td and (td / w).exists():
            other[w] = round(float(max(engine.score_audio(read_wav_16k_mono(td / w)))), 4)
    result["other_clips"] = other
    for w in args.wav:
        result.setdefault("extra_wavs", {})[w] = round(float(max(engine.score_audio(read_wav_16k_mono(w)))), 4)
    import shutil

    shutil.rmtree(work, ignore_errors=True)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
