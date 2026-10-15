"""openWakeWord-style streaming pipeline in Python.

Mirrors the Rust engine in BlitzVoice (wakeword/engine.rs): 80 ms frames, the mel
model is fed int16-scale values, mel frames are mapped with x / 10 + 2, one
embedding per frame from the newest 76 mel frames, and the wake model scores
the newest N embeddings.
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soundfile as sf

FRAME = 1280
MEL_CONTEXT = 480
MEL_BINS = 32
EMBED_WINDOW = 76
EMBED_DIM = 96


def default_feature_dir() -> Path:
    """The folder with melspectrogram.onnx and embedding_model.onnx: WAKEWORD_FEATURE_DIR when set, else the copy that
    livekit-wakeword ships (the same openWakeWord models BlitzVoice uses)."""
    env = os.environ.get("WAKEWORD_FEATURE_DIR")
    if env:
        return Path(env)
    from livekit.wakeword.resources import get_mel_model_path
    return Path(get_mel_model_path()).parent


def read_wav_16k_mono(path) -> np.ndarray:
    audio, sr = sf.read(str(path), dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if sr != 16000:
        import soxr

        audio = soxr.resample(audio, sr, 16000).astype(np.float32)
    return audio


class StreamEngine:
    def __init__(self, model_path, feature_dir=None):
        feature_dir = Path(feature_dir) if feature_dir else default_feature_dir()
        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        cpu = ["CPUExecutionProvider"]
        self.mel = ort.InferenceSession(str(feature_dir / "melspectrogram.onnx"), opts, providers=cpu)
        self.emb = ort.InferenceSession(str(feature_dir / "embedding_model.onnx"), opts, providers=cpu)
        self.wake = ort.InferenceSession(str(model_path), opts, providers=cpu)
        win = self.wake.get_inputs()[0]
        self.window = int(win.shape[1])
        self.mel_in = self.mel.get_inputs()[0].name
        self.emb_in = self.emb.get_inputs()[0].name
        self.wake_in = win.name
        self.reset()

    def reset(self):
        self.raw = np.zeros(FRAME + MEL_CONTEXT, dtype=np.float32)
        self.mel_ring = np.ones((EMBED_WINDOW, MEL_BINS), dtype=np.float32)
        self.features = np.zeros((self.window, EMBED_DIM), dtype=np.float32)

    def push(self, frame: np.ndarray) -> float:
        self.raw[:-FRAME] = self.raw[FRAME:]
        self.raw[-FRAME:] = np.clip(frame * 32768.0, -32768.0, 32767.0)
        out = self.mel.run(None, {self.mel_in: self.raw[None, :]})[0]
        rows = out.reshape(-1, MEL_BINS)[-EMBED_WINDOW:]
        n = rows.shape[0]
        self.mel_ring[:-n] = self.mel_ring[n:]
        self.mel_ring[-n:] = rows / 10.0 + 2.0
        e = self.emb.run(None, {self.emb_in: self.mel_ring[None, :, :, None]})[0]
        self.features[:-1] = self.features[1:]
        self.features[-1] = e.reshape(-1)[:EMBED_DIM]
        s = self.wake.run(None, {self.wake_in: self.features[None]})[0]
        return float(s.reshape(-1)[0])

    def score_audio(self, audio: np.ndarray, tail_silence: float = 0.4) -> list[float]:
        self.reset()
        audio = np.concatenate([audio, np.zeros(int(16000 * tail_silence), np.float32)])
        n = len(audio) // FRAME
        return [self.push(audio[i * FRAME:(i + 1) * FRAME]) for i in range(n)]
