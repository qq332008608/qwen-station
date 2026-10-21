# Qwen Station

A standalone agent runtime for a local Qwen model (OpenAI-compatible server). One Node.js file (`station.cjs`) handles plugin loading, the chat/tool loop, session storage and a web UI; `studio.cjs` + `studio.html` add an AI film production flow (`/studio`) that drives ComfyUI and a workbench.

## Run

```powershell
node station.cjs        # or .\start.ps1
```

Then open http://127.0.0.1:18800 (studio at `/studio`).

## Configure

Edit `config.json`: model endpoint (`model.baseUrl`, `model.id`), `workspace` (file access is restricted to it), `comfyPorts`, `workbench`, and read-only `readRoots`.

## Plugins

`plugins/*.cjs` each export `{ name, tools: [{ name, description, parameters, run(args, ctx) }] }`. Included: files, web, ComfyUI submit, workbench, GitHub, browser, memory, workboard, document extract, summarize, diagrams, media, sub-agents.

## KV-cache friendly design

The system prompt is generated once per session and frozen; history is append-only and tool results are truncated at write time, so the prompt prefix stays stable and cached KV blocks can be reused.
