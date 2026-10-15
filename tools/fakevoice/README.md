# Fake BlitzVoice (tests only)

Stands in for BlitzVoice's local control server, so the Mission Control voice link can be tested without a microphone, speech or the real app. It writes a `control.json` (port, token, pid) for Mission Control to find, and logs every request it gets.

```powershell
node tools\fakevoice\fake-voice.js C:\scratch\voice\control.json
$env:MC_VOICE_CONTROL_FILE = 'C:\scratch\voice\control.json'
$env:MC_PORT = '47110'
node server/index.js
```

Options: `--port N` (default random in 47200 to 47899), `--speak-ms N` (how long it "speaks" after /speak, default 4000), `--cleanup-unavailable` (/start answers `cleanup: "unavailable"` when asked for cleanup), `--log <file>` (default `fakevoice.log` next to control.json), `--cap-ms N` (the cap of a dictation with no automatic stop, default 120000, the real one is 120s).

- Every call needs `Authorization: Bearer <token>`, otherwise 401.
- `GET /events`: SSE with `hello`, `wake_state`, `state` (idle, recording, transcribing, speaking), `level` while recording, and `transcript` after /stop.
- `POST /start {deliver, cleanup?, model?, partials?, autostop?}` (`partials: true` turns on live words, `autostop` is `"none"` or `"silence"`) answers `{ok, id}` (409 busy unless idle or speaking, and a start while speaking ends the speech). `/stop` goes to transcribing and then sends the text "fake dictation N". `/cancel` goes back to idle. `/discard` ends a dictation at once (idle, no transcription, no transcript event; 409 when not recording). With `autostop: "none"` the dictation runs until `/stop`, `/cancel` or `/discard`, or ends at the cap with `transcript {id, text: "", error: "timeout"}`.
- With `partials: true` the dictation sends `partial {id, text}` (the latest full text). `POST /test/say {text, delay?, replace?}` (test helper) says the words one by one, `delay` ms apart (default 60), each one a growing partial; it adds to the text so far, or replaces it with `replace: true`. `/stop` then transcribes the text said so far (the text "fake dictation N" when nothing was said).
- `POST /speak {text, voice?}`: 200 `{ok:true}` and state `speaking` for `--speak-ms`, then idle. 400 for text outside 1 to 20000 characters. 409 `{error:"busy"}` while recording or transcribing.
- `POST /speak/stop`: 200 `{ok:true}`, state idle.
- `POST /transcribe` (a phone's recording): the body is a WAV (`Content-Type: audio/wav`, RIFF/WAVE, PCM 16-bit mono 16000 Hz, max 4 MB). 200 `{ok:true, text, ms}` where `text` is "what's the status of BlitzRaw" unless set with `--transcribe-text "..."`, the `FAKEVOICE_TRANSCRIBE_TEXT` environment variable, or the test helper `POST /test/transcribe-text {text}` (an empty text means nothing was heard). 400 `{error:"bad_audio"}` for a wrong header or format, 409 `{error:"busy"}` while recording or transcribing, 413 `{error:"too_large"}` over 4 MB.
- `/transcribe` also answers 409 `{error:"no_link_model"}` (no "Model for Mission Control" is chosen in BlitzVoice), and `/speak` with `to:"wav"` 409 `{error:"busy"}` or 400 over 4000 characters. The test helper `POST /test/fail {transcribe?: "no_link_model" | "busy" | null, speak?: "busy" | null}` makes the next calls fail that way until it is called again with null.
- `POST /speak {text, to:"wav"}`: 200 `{ok:true, wav, seconds, ms}` where `wav` is a base64 PCM 16-bit mono 24000 Hz WAV (a 0.6 s tone, or `--tone-ms N` long). Nothing "plays" and the state does not change.
- The log has one JSON line per request (method, path, body, status) and per state change. Stop the fake by its exact process id (it is printed on start and written in control.json).

## Wake word

- `GET /wake` answers the status `{enabled, state, paused_reason, model, threshold, models, autostop, error}`. State is `off`, `loading`, `listening`, `paused` or `error`; `paused_reason` is `no_link` (no `/events` subscriber), `speaking` or `dictating`. Starts off. Option `--wake-model <id>` picks the starting model (default `hey_jarvis_v0.1`; the other known one is `alexa_v0.1`).
- `POST /wake` takes any of `{enabled: bool, model: string, threshold: 0.05 to 0.99, autostop: "silence" | "phrase"}` and nothing else (`autostop` is a string in the status too, default `"silence"`). 200 with the new status; 400 for a bad body, an unknown key or an unknown model.
- `/events` sends `wake_state {status}` right after `hello` and on every change of the status (enabling, a speech or dictation pausing it, the last subscriber leaving).
- Test helpers (not in the real contract): `POST /test/wake {text?, delay?, id?}` acts out a wake dictation: `wake {id, model, score}`, state `recording`, `transcribing`, then `transcript {id, text, wake: true}` and `idle`. When the wake `autostop` is `"phrase"` the dictation instead runs like `/start` with partials and no automatic stop: a `text` is said word by word (`wordDelay` ms apart, default 60), more words come from `/test/say`, and it ends by `/stop` (transcript with `wake: true`), `/cancel`, `/discard` or the cap. An explicit `id` replays that id (the server must send it only once). It answers 409 unless the wake word is listening. `POST /test/wake-status {state, paused_reason?, error?}` forces a status (for example `error` with a message) until it is called with `{}`.
