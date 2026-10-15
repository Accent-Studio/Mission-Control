# WakeTrainer

Trains a custom wake word model on your own PC. It wraps [livekit-wakeword](https://github.com/livekit/livekit-wakeword) and produces an ONNX file that BlitzVoice can load (input `[1, 16, 96]` float32, output `[1, 1]`).

Everything (the Python environment, caches, data sets and runs) stays inside this folder. Nothing is written to AppData (see `env.ps1` and `env.bat`). Mission Control's Wake words page runs it for you.

## Train a model

```
train.bat --phrase "hey mission control" --out models\hey_mission_control.onnx
```

Options:

- `--phrase "<text>"`: the wake phrase (required).
- `--out <file.onnx>`: where the finished model is copied. Default is `models\<phrase>.onnx`.
- `--clips <folder>`: your own recordings of the phrase (WAV, FLAC or OGG, any sample rate, up to 2 seconds each). They are converted to 16kHz mono, trimmed, and mixed into the positive examples. Recordings of your own voice make a big difference, 30 to 50 clips is a good number.
- `--preset quick|standard|thorough`: size of the run. `standard` is the default.
- `--steps N`, `--samples N`, `--rounds N`: override the preset.
- `--negatives "a b,c d"`: extra phrases that must not trigger.
- `--keep-work`: keep the generated clips after the run.

Progress goes to stdout as one JSON object per line:

```
{"stage":"generate|augment|features|train|export|verify","pct":42,"msg":"..."}
{"done":true,"out":"...","seconds":1234.5,"timings":{...},"verify":{...}}
{"error":"..."}
```

Logs and the run files go to `runs\<name>\` (`train.log`, `summary.json`, the evaluation plot).

## One-time setup

1. `python -m venv .venv`, then install torch from the cu126 index and `livekit-wakeword[train,eval,export]` plus `onnxruntime-gpu==1.23.2` (this version matches the CUDA 12 libraries that torch ships).
2. Put espeak-ng in `tools\espeak-ng` (`espeak-ng.exe`, `libespeak-ng.dll` and the `espeak-ng-data` folder, copied from an espeak-ng install). The Piper voices need it.
3. `setup.ps1` downloads the data sets (about 23GB: Piper voices, 2000 hours of speech features, room impulse responses, noise). It can be run again if interrupted.

## Check a model against BlitzVoice

```
.venv\Scripts\python.exe check_blitzvoice.py --model models\hey_mission_control.onnx
```

This applies the same shape rules as BlitzVoice's model catalog and runs the same streaming pipeline (80ms frames, `melspectrogram.onnx`, `embedding_model.onnx`) on fresh synthetic voices, silence and noise.

## Files

- `train.py`: the trainer (stages, JSON output, checks).
- `wt_patches.py`: patches applied at run time (GPU feature extraction, phoneme cache, progress).
- `stream_pipeline.py`: the streaming pipeline in Python.
- `check_blitzvoice.py`: compatibility check.

## Timings (RTX 4070 Ti SUPER)

The `standard` preset for "hey mission control" took 43 minutes: generate 7.2 min, augment 9.7 min, features 6.7 min (on the GPU), train 17.6 min, export and verify about 1 min. The `quick` preset takes about 12 minutes.

Phrases that sound close to the wake phrase (for example "hey vision control") can still trigger it, because the synthetic training voices cannot teach every near miss. Pass the ones you care about with `--negatives "hey vision control,hey michigan control"`, and add recordings of your own voice with `--clips`.
