# Ollama (native Windows)

1. Install Ollama from https://ollama.com/download (Windows installer). It runs as a tray app and serves on port 11434.
2. Pull the model: `ollama pull qwen2.5-coder:7b-instruct-q4_K_M`
3. Set the context to match the other engines before starting the server (PowerShell):
   `$env:OLLAMA_CONTEXT_LENGTH = "16384"; ollama serve`
   (Quit the tray app first, or the port is taken.)
4. Check: `curl http://localhost:11434/v1/models` lists `qwen2.5-coder:7b-instruct-q4_K_M`.

The bench records the version from `GET /api/version`. Tool calling is Ollama's own for this model, with no parser flag.
