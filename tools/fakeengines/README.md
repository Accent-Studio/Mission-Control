# Fake local AI engines (tests only)

Stands in for Ollama, a llama.cpp router, llama-swap, LM Studio and ComfyUI, so the model list and the unload buttons can be tested without loading a single real model. Point a test server at it with `MC_ENGINE_PORTS`:

```powershell
node tools\fakeengines\fake-engines.js
$env:MC_ENGINE_PORTS = 'ollama=47301,llamacpp=47302,llamaswap=47303,lmstudio=47304,comfyui=47305'
$env:MC_PORT = '47140'
node server/index.js
```

Options: `--ports "<same list>"` (default `MC_ENGINE_PORTS`, then the list above), `--comfy-busy` (ComfyUI shows a running job in `/queue`), `--llamacpp-single` (llama.cpp answers like a single-model server, no unload), `--log <file>` (also append the request log there).

- Each engine has two or three loaded models. Unloading one is real: it disappears from the next list. ComfyUI lists none; `/free` drops its used memory.
- Ollama: `/api/version`, `/api/ps`, `/api/generate` with `keep_alive: 0`. llama.cpp router: `/props`, `/models`, `/models/unload`, `/models/load` (one extra model starts unloaded). llama-swap: `/running`, `/api/models/unload/:id`. LM Studio: `/api/v1/models`, `/api/v1/models/unload`. ComfyUI: `/system_stats`, `/queue`, `/free`, also under `/api`.
- ComfyUI busy toggle at run time: `POST http://127.0.0.1:47305/__busy` with `{"busy": true}`.
- Every request is printed as one JSON line (engine, method, path, body, status). Stop the fake by its exact process id (printed on start).
