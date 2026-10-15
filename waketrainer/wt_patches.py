"""Runtime patches for livekit-wakeword 0.3.0, applied from our own wrapper.

Nothing under site-packages is edited by hand. Each patch below is a record of
what differs from the stock package and why.

1. GPU feature extraction (livekit-wakeword issue #70).
   The package hard-codes CPUExecutionProvider for the mel and embedding models,
   which makes the features stage about 25x slower. We open both sessions with the
   CUDA provider first and fall back to CPU. torch must be imported before
   onnxruntime so that onnxruntime can find torch's CUDA and cuDNN DLLs.

2. espeak-ng phoneme cache.
   The stock code starts one espeak-ng process per generated clip. On this PC a
   process start costs 0.2 to 2 seconds. We cache the result per text and fill the
   cache in parallel before each generation pass.

3. Cap on adversarial negative phrases.
   The stock code returns every phonetic neighbor it finds (thousands). Each
   distinct text needs one espeak-ng run, and voice variety comes from the
   speakers anyway, so we keep a random sample.

4. GPU memory cap (done in train.py) and cache release after each synthesis pass.
   Without it the CUDA allocator grew to the full 16GB during generation and the
   driver started paging to system memory, which made one pass 30x slower.

5. Progress reporting.
   tqdm bars are replaced by a subclass that feeds a progress tracker, so the
   wrapper can print one JSON line per stage.
"""
from __future__ import annotations

import functools
import logging
import random
import sys
from concurrent.futures import ThreadPoolExecutor

log = logging.getLogger("wakeword.patches")

_applied = False


def apply_gpu_feature_extraction() -> str:
    import torch  # noqa: F401  (must come first, see module docstring)
    import onnxruntime as ort

    try:
        ort.preload_dlls()
    except Exception as e:  # older onnxruntime builds
        log.warning("preload_dlls failed: %s", e)

    from livekit.wakeword.models import feature_extractor as fe
    from livekit.wakeword.session import session_options

    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    if "CUDAExecutionProvider" not in ort.get_available_providers():
        providers = ["CPUExecutionProvider"]

    def mel_init(self, onnx_path, sess_options=None):
        self._onnx_session = ort.InferenceSession(
            str(onnx_path), providers=providers, sess_options=session_options(sess_options)
        )
        self._input_name = self._onnx_session.get_inputs()[0].name

    orig_emb_init = fe.SpeechEmbedding.__init__

    def emb_init(self, onnx_path, sess_options=None):
        orig_emb_init(self, onnx_path, sess_options)  # path checks, CPU session
        self._session = ort.InferenceSession(
            str(onnx_path), providers=providers, sess_options=session_options(sess_options)
        )
        self._input_name = self._session.get_inputs()[0].name

    fe.MelSpectrogramFrontend._init_onnx = mel_init
    fe.SpeechEmbedding.__init__ = emb_init
    return providers[0]


def apply_phoneme_cache(max_negative_phrases: int = 300) -> None:
    from livekit.wakeword.data.piper import synthesis
    from livekit.wakeword.data.tts import piper_backend
    from livekit.wakeword.data import generate as gen

    raw_phonemize = synthesis._espeak_phonemize
    cached = functools.lru_cache(maxsize=None)(raw_phonemize)
    synthesis._espeak_phonemize = cached

    orig_synth = piper_backend.PiperVitsBackend.synthesize_clips

    def synth(self, phrases, output_dir, n_samples, **kw):
        texts = sorted(set(piper_backend.normalize_phrases_for_piper(phrases)))
        log.info("Phonemizing %d distinct phrases", len(texts))
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda t: cached(t, "en-us"), texts))
        try:
            return orig_synth(self, phrases, output_dir, n_samples, **kw)
        finally:
            import torch

            torch.cuda.empty_cache()

    piper_backend.PiperVitsBackend.synthesize_clips = synth

    # The stock get_cmudict() calls nltk.download. The cmudict pip package ships
    # the same dictionary, so use that and stay offline.
    from livekit.wakeword.data.piper import text as ptext

    def offline_cmudict():
        import cmudict

        return {w: prons[0] for w, prons in cmudict.dict().items()}

    ptext.get_cmudict = offline_cmudict
    gen.get_cmudict = offline_cmudict
    synthesis_text = sys.modules.get("livekit.wakeword.data.piper")
    if synthesis_text is not None:
        synthesis_text.get_cmudict = offline_cmudict
    ptext_cache = {}

    orig_normalize = ptext.normalize_phrases_for_piper

    def normalize(phrases):
        cmu = ptext_cache.setdefault("cmu", offline_cmudict())
        return [" ".join(ptext.expand_unknown_words(p.lower().split(), cmu)) for p in phrases]

    ptext.normalize_phrases_for_piper = normalize
    piper_backend.normalize_phrases_for_piper = normalize

    orig_adv = gen.generate_adversarial_phrases

    def adv(target_phrases, **kw):
        out = orig_adv(target_phrases, **kw)
        if len(out) > max_negative_phrases:
            out = random.sample(out, max_negative_phrases)
        return out

    gen.generate_adversarial_phrases = adv


class Tracker:
    """Counts tqdm updates for the current stage and reports progress."""

    def __init__(self, emit):
        self.emit = emit
        self.stage = None
        self.total = 1
        self.done = 0
        self.last_pct = -1
        self.last_t = 0.0
        self.msg = ""

    def begin(self, stage, total, msg=""):
        self.stage, self.total, self.done = stage, max(1, int(total)), 0
        self.last_pct, self.last_t, self.msg = -1, 0.0, msg
        self.report(force=True)

    def add(self, n, msg=None):
        import time

        self.done += n
        if msg:
            self.msg = msg
        now = time.time()
        pct = min(99, int(100 * self.done / self.total))
        if pct != self.last_pct and (pct - self.last_pct >= 2 or now - self.last_t > 5):
            self.report()

    def report(self, force=False):
        import time

        pct = min(99, int(100 * self.done / self.total)) if self.total else 0
        self.last_pct, self.last_t = pct, time.time()
        self.emit(stage=self.stage, pct=pct, msg=self.msg)


def apply_progress(tracker: Tracker) -> None:
    import tqdm
    import tqdm.std

    class ProgTqdm(tqdm.std.tqdm):
        def __init__(self, *a, **kw):
            kw.setdefault("mininterval", 10.0)
            super().__init__(*a, **kw)
            self._desc_for_msg = kw.get("desc", "") or ""

        def update(self, n=1):
            r = super().update(n)
            try:  # progress reporting must never break the pipeline
                tracker.add(n if n is not None else 1, self._desc_for_msg)
            except Exception:
                pass
            return r

    tqdm.tqdm = ProgTqdm
    tqdm.std.tqdm = ProgTqdm


def apply_all(tracker: Tracker, max_negative_phrases: int = 300) -> dict:
    global _applied
    info = {}
    if not _applied:
        info["feature_provider"] = apply_gpu_feature_extraction()
        apply_phoneme_cache(max_negative_phrases)
        apply_progress(tracker)
        _applied = True
    return info
