"""Train a wake word model for a phrase, on this PC.

Usage (through train.bat or train.ps1, which set up the environment first):

    train.bat --phrase "hey mission control" --out models\\model.onnx
              [--clips <folder of WAV recordings>] [--preset quick|standard|thorough]
              [--steps N] [--samples N] [--rounds N]

stdout carries one JSON object per line and nothing else:

    {"stage":"generate|augment|features|train|export|verify","pct":n,"msg":"..."}
    {"done":true,"out":"...","seconds":n,...}      or      {"error":"..."}

Logs and tracebacks go to stderr and to runs/<name>/train.log. Nothing is written
outside the WakeTrainer folder except the --out file.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# Everything lives on V:. Force these even if the caller forgot to run env.ps1.
_ENV = {
    "WAKETRAINER_ROOT": str(ROOT),
    "PIP_CACHE_DIR": str(ROOT / "cache" / "pip"),
    "HF_HOME": str(ROOT / "cache" / "hf"),
    "HF_HUB_CACHE": str(ROOT / "cache" / "hf" / "hub"),
    "TORCH_HOME": str(ROOT / "cache" / "torch"),
    "XDG_CACHE_HOME": str(ROOT / "cache"),
    "TEMP": str(ROOT / "tmp"),
    "TMP": str(ROOT / "tmp"),
    "TMPDIR": str(ROOT / "tmp"),
    "PYTHONUTF8": "1",
    "PYTHONIOENCODING": "utf-8",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "ESPEAK_DATA_PATH": str(ROOT / "tools" / "espeak-ng"),
}
os.environ.update(_ENV)
os.environ["PATH"] = str(ROOT / "tools" / "espeak-ng") + os.pathsep + os.environ.get("PATH", "")
(ROOT / "tmp").mkdir(exist_ok=True)

# Keep stdout clean for JSON lines: anything else that prints goes to stderr.
_JSON_OUT = sys.stdout
sys.stdout = sys.stderr
sys.path.insert(0, str(ROOT))

PRESETS = {
    # n_samples, n_samples_val, rounds, steps, background clips (train, test)
    "quick": dict(n=3000, nv=600, rounds=1, steps=8000, bg=(500, 100)),
    "standard": dict(n=10000, nv=2000, rounds=2, steps=30000, bg=(2000, 400)),
    "thorough": dict(n=25000, nv=5000, rounds=3, steps=100000, bg=(2000, 400)),
    "smoke": dict(n=200, nv=60, rounds=1, steps=300, bg=(40, 10)),
}

STAGES = ["generate", "augment", "features", "train", "export", "verify"]
_t0 = time.time()
_log_file = None


def emit(**kw):
    _JSON_OUT.write(json.dumps(kw, ensure_ascii=False) + "\n")
    _JSON_OUT.flush()


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, file=sys.stderr, flush=True)
    if _log_file:
        _log_file.write(line + "\n")
        _log_file.flush()


class GpuSampler(threading.Thread):
    """Polls nvidia-smi so each stage can report GPU utilization and memory."""

    def __init__(self, interval=4.0):
        super().__init__(daemon=True)
        self.interval = interval
        self.samples = []
        self._halt = threading.Event()

    def run(self):
        while not self._halt.wait(self.interval):
            try:
                out = subprocess.run(
                    ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
                    capture_output=True, text=True, timeout=10,
                ).stdout.strip().splitlines()[0]
                u, m = [float(x) for x in out.split(",")]
                self.samples.append((time.time(), u, m))
            except Exception:
                pass

    def stop(self):
        self._halt.set()

    def summary(self, t_from, t_to):
        s = [(u, m) for t, u, m in self.samples if t_from <= t <= t_to]
        if not s:
            return {}
        return {
            "gpu_util_mean": round(sum(u for u, _ in s) / len(s), 1),
            "gpu_util_max": max(u for u, _ in s),
            "gpu_mem_max_mb": max(m for _, m in s),
        }


def slugify(phrase):
    s = re.sub(r"[^a-z0-9]+", "_", phrase.lower()).strip("_")
    return s or "wakeword"


def prepare_real_clips(src: Path, run_dir: Path, n_train: int, n_test: int, sample_rate=16000):
    """Load the owner's recordings as 16 kHz mono, trim the edges, and add them
    to the positive splits (several copies each, the augmentation makes every
    copy different). Returns a dict with counts and the held-out test paths."""
    import numpy as np
    import soundfile as sf
    import soxr

    files = sorted(p for p in src.rglob("*") if p.suffix.lower() in (".wav", ".flac", ".ogg"))
    clips = []
    for p in files:
        try:
            audio, sr = sf.read(str(p), dtype="float32", always_2d=True)
        except Exception as e:
            log(f"skipping unreadable clip {p.name}: {e}")
            continue
        audio = audio.mean(axis=1)
        if sr != sample_rate:
            audio = soxr.resample(audio, sr, sample_rate).astype("float32")
        # Trim silence at both ends (frames 20 ms, threshold 35 dB under the loudest frame).
        hop = 320
        n = len(audio) // hop
        if n < 3:
            continue
        rms = np.sqrt((audio[: n * hop].reshape(n, hop) ** 2).mean(axis=1) + 1e-12)
        keep = np.where(rms > rms.max() * 10 ** (-35 / 20))[0]
        a0 = max(0, keep[0] * hop - 1280)
        a1 = min(len(audio), (keep[-1] + 1) * hop + 1280)
        audio = audio[a0:a1]
        peak = float(np.abs(audio).max())
        if peak < 1e-4:
            continue
        audio = audio * (0.8 / peak)
        if len(audio) > 2 * sample_rate:
            log(f"skipping {p.name}: {len(audio) / sample_rate:.1f}s is longer than the 2s window")
            continue
        clips.append((p.name, audio))
    if not clips:
        raise RuntimeError(f"no usable audio clips found in {src}")

    k_test = max(1, round(len(clips) * 0.2)) if len(clips) >= 5 else 0
    test_clips, train_clips = clips[:k_test], clips[k_test:]
    test_paths = []

    def write(split, items, copies, start_index):
        d = run_dir / split
        d.mkdir(parents=True, exist_ok=True)
        idx = start_index
        for _ in range(copies):
            for name, a in items:
                sf.write(str(d / f"clip_{idx:06d}.wav"), (a * 32767).astype("int16"), sample_rate, subtype="PCM_16")
                idx += 1
        return idx - start_index

    # Real recordings make up about 15 percent of the positives, at most 60 copies each.
    c_train = max(1, min(60, round(0.15 * n_train / max(1, len(train_clips)))))
    c_test = max(1, min(60, round(0.15 * n_test / max(1, len(test_clips))))) if test_clips else 0
    w_train = write("positive_train", train_clips, c_train, n_train)
    w_test = write("positive_test", test_clips, c_test, n_test) if test_clips else 0
    held = run_dir / "real_heldout"
    held.mkdir(parents=True, exist_ok=True)
    for name, a in test_clips:
        sf.write(str(held / name if name.endswith(".wav") else held / (name + ".wav")), (a * 32767).astype("int16"), sample_rate, subtype="PCM_16")
        test_paths.append(held / (name if name.endswith(".wav") else name + ".wav"))
    return {
        "clips": len(clips), "train_clips": len(train_clips), "test_clips": len(test_clips),
        "train_copies": c_train, "train_files": w_train, "test_files": w_test,
        "heldout": test_paths,
    }


def build_config(args, preset, name):
    from livekit.wakeword.config import WakeWordConfig

    negatives = [s.strip() for s in (args.negatives or "").split(",") if s.strip()]
    words = args.phrase.lower().split()
    # Near misses: the phrase without its first word, and each word alone is added by the
    # package already. Add a couple of shape-alike phrases for multi-word phrases.
    if len(words) >= 2:
        negatives.append(" ".join(words[1:]))
        negatives.append(" ".join(words[:-1]))
    cfg = dict(
        model_name=name,
        target_phrases=[args.phrase.lower()],
        custom_negative_phrases=sorted(set(negatives)),
        n_samples=args.samples or preset["n"],
        n_samples_val=preset["nv"] if not args.samples else max(200, args.samples // 5),
        n_background_samples=preset["bg"][0],
        n_background_samples_val=preset["bg"][1],
        tts_batch_size=50,
        data_dir=str(ROOT / "data"),
        output_dir=str(ROOT / "runs"),
        steps=args.steps or preset["steps"],
        augmentation=dict(
            rounds=args.rounds or preset["rounds"],
            background_paths=[str(ROOT / "data" / "backgrounds")],
            rir_paths=[str(ROOT / "data" / "rirs")],
        ),
        model=dict(model_type=args.model_type, model_size=args.model_size),
    )
    return WakeWordConfig(**cfg)


def run(args):
    global _log_file
    preset = PRESETS[args.preset]
    name = args.name or slugify(args.phrase)
    out_path = Path(args.out) if args.out else ROOT / "models" / f"{name}.onnx"
    run_dir = ROOT / "runs" / name
    if run_dir.exists():
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True)
    _log_file = open(run_dir / "train.log", "a", encoding="utf-8")
    log(f"phrase={args.phrase!r} preset={args.preset} name={name} out={out_path}")

    from wt_patches import Tracker, apply_all

    tracker = Tracker(emit)
    info = apply_all(tracker, max_negative_phrases=args.max_negatives)
    import torch

    if torch.cuda.is_available():
        # Cap the allocator well under the card's 16GB (other programs use some too).
        torch.cuda.set_per_process_memory_fraction(0.6)
    log(f"patches applied: {info}")

    cfg = build_config(args, preset, name)
    import yaml

    (run_dir / "config.yaml").write_text(yaml.safe_dump(json.loads(cfg.model_dump_json())), encoding="utf-8")

    n, nv, rounds, steps = cfg.n_samples, cfg.n_samples_val, cfg.augmentation.rounds, cfg.steps
    n_bg, n_bg_v = cfg.n_background_samples, cfg.n_background_samples_val
    split_total = 2 * n + 2 * nv + n_bg + n_bg_v  # clips per augmentation round
    real = None

    sampler = GpuSampler()
    sampler.start()
    timings = {}

    def stage(stage_name, total, msg):
        stage.t = time.time()
        stage.name = stage_name
        log(f"== stage {stage_name}: {msg}")
        tracker.begin(stage_name, total, msg)

    def end_stage(extra_msg=""):
        t1 = time.time()
        timings[stage.name] = {"seconds": round(t1 - stage.t, 1), **sampler.summary(stage.t, t1)}
        emit(stage=stage.name, pct=100, msg=extra_msg or "done")
        log(f"   {stage.name} took {timings[stage.name]}")

    # ---- generate
    from livekit.wakeword.data.generate import run_generate

    stage("generate", 2 * n + 2 * nv + n_bg + n_bg_v, "synthesizing speech clips")
    run_generate(cfg)
    if args.clips:
        real = prepare_real_clips(Path(args.clips), run_dir, n, nv)
        log(f"real clips: { {k: v for k, v in real.items() if k != 'heldout'} }")
    end_stage()

    # ---- augment
    from livekit.wakeword.data.augment import run_augment

    extra = (real["train_files"] + real["test_files"]) if real else 0
    stage("augment", rounds * (split_total + extra), "augmenting clips")
    run_augment(cfg)
    end_stage()

    # ---- features
    from livekit.wakeword.data.features import run_extraction
    from onnxruntime import SessionOptions

    stage("features", rounds * (split_total + extra), "extracting embeddings")
    run_extraction(cfg, SessionOptions())
    end_stage()

    # ---- train
    from livekit.wakeword.training.trainer import run_train

    stage("train", steps + 2 * (steps // 10), "training the classifier")
    run_train(cfg)
    end_stage()

    # ---- export
    from livekit.wakeword.export.onnx import run_export

    stage("export", 1, "exporting ONNX")
    onnx_path = run_export(cfg)
    end_stage()

    # ---- verify
    stage("verify", 1, "checking the model")
    verdict = verify(cfg, onnx_path, real["heldout"] if real else [], run_dir)
    end_stage("pass" if verdict["pass"] else "checks failed, see summary")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(onnx_path, out_path)

    if not args.keep_work:
        for sub in ("positive_train", "positive_test", "negative_train", "negative_test",
                    "background_train", "background_test", "verify_tts", "real_heldout"):
            shutil.rmtree(run_dir / sub, ignore_errors=True)
    sampler.stop()
    total = round(time.time() - _t0, 1)
    summary = {"done": True, "out": str(out_path), "seconds": total, "timings": timings, "verify": verdict}
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    emit(**summary)
    log(f"done in {total}s")


def verify(cfg, onnx_path: Path, heldout, run_dir: Path):
    """Shape check, validation-set metrics, and streaming scores on fresh synthetic
    voices, silence, noise, and held-out real recordings."""
    import numpy as np
    import onnxruntime as ort
    import soundfile as sf

    from livekit.wakeword.data.tts.piper_backend import PiperVitsBackend
    from livekit.wakeword.eval.evaluate import run_eval
    from livekit.wakeword.resources import get_mel_model_path
    from stream_pipeline import StreamEngine, read_wav_16k_mono

    res = {}
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    i, o = sess.get_inputs()[0], sess.get_outputs()[0]
    res["input"] = {"name": i.name, "shape": list(i.shape), "type": i.type}
    res["output"] = {"name": o.name, "shape": list(o.shape), "type": o.type}
    shapes_ok = (len(i.shape) == 3 and i.shape[2] == 96 and isinstance(i.shape[1], int)
                 and i.type == "tensor(float)" and len(o.shape) == 2 and o.shape[1] == 1
                 and o.type == "tensor(float)")
    res["shapes_ok"] = bool(shapes_ok)
    log("verify: running validation-set metrics")
    ev = run_eval(cfg, onnx_path)
    res["eval"] = {k: (round(v, 4) if isinstance(v, float) else v) for k, v in ev.items()}

    feature_dir = Path(get_mel_model_path()).parent
    engine = StreamEngine(onnx_path, feature_dir)

    vdir = run_dir / "verify_tts"
    backend = PiperVitsBackend.from_config(cfg)
    phrase = cfg.target_phrases[0]
    words = phrase.split()
    unrelated = ["what is the weather today", "please open the window", "turn off the lights"]
    near = [t for t in cfg.custom_negative_phrases][:4]
    negs = unrelated + near
    pos_files = backend.synthesize_clips([phrase], vdir / "pos", 400016, start_index=400000, batch_size=16)
    neg_files = {}
    for k, t in enumerate(negs):
        neg_files[t] = backend.synthesize_clips([t], vdir / f"neg{k}", 400006, start_index=400000, batch_size=6)

    def peak(audio):
        return float(max(engine.score_audio(audio)))

    pos = [peak(read_wav_16k_mono(p)) for p in pos_files]
    neg = {t: [peak(read_wav_16k_mono(p)) for p in fs] for t, fs in neg_files.items()}
    rng = np.random.default_rng(1)
    quiet = {
        "silence": np.zeros(48000, np.float32),
        "room_noise": (rng.standard_normal(48000) * 0.003).astype(np.float32),
        "loud_noise": (rng.standard_normal(48000) * 0.1).astype(np.float32),
    }
    noise = {k: peak(v) for k, v in quiet.items()}
    res["tts_positive_peaks"] = {"min": round(min(pos), 3), "median": round(float(np.median(pos)), 3),
                                 "max": round(max(pos), 3), "n": len(pos)}
    res["unrelated_negative_peaks"] = {t: round(max(neg[t]), 3) for t in unrelated}
    res["near_miss_negative_peaks"] = {t: round(max(neg[t]), 3) for t in near}
    res["noise_peaks"] = {k: round(v, 4) for k, v in noise.items()}
    if heldout:
        rp = [peak(read_wav_16k_mono(p)) for p in heldout]
        res["real_heldout_peaks"] = {"min": round(min(rp), 3), "median": round(float(np.median(rp)), 3), "n": len(rp)}
    ok = (shapes_ok and np.median(pos) >= 0.5 and max(max(neg[t]) for t in unrelated) < 0.5
          and max(noise.values()) < 0.2)
    res["pass"] = bool(ok)
    return res


def main():
    ap = argparse.ArgumentParser(description="Train a wake word model.")
    ap.add_argument("--phrase", required=True, help='wake phrase, for example "hey mission control"')
    ap.add_argument("--clips", help="folder with the owner's WAV recordings of the phrase")
    ap.add_argument("--out", help="where to copy the finished .onnx (default models\\<name>.onnx)")
    ap.add_argument("--preset", choices=sorted(PRESETS), default="standard")
    ap.add_argument("--steps", type=int)
    ap.add_argument("--samples", type=int, help="synthetic positive clips (and as many negatives)")
    ap.add_argument("--rounds", type=int)
    ap.add_argument("--name", help="run folder and model name (default: the phrase as a slug)")
    ap.add_argument("--negatives", help="comma separated extra phrases that must not trigger")
    ap.add_argument("--max-negatives", type=int, default=300, help="cap on distinct adversarial phrases")
    ap.add_argument("--model-type", default="conv_attention", choices=["dnn", "rnn", "conv_attention"])
    ap.add_argument("--model-size", default="medium", choices=["tiny", "small", "medium", "large"])
    ap.add_argument("--keep-work", action="store_true", help="keep generated wav clips after the run")
    args = ap.parse_args()
    try:
        run(args)
        return 0
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        if _log_file:
            traceback.print_exc(file=_log_file)
        emit(error=f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
