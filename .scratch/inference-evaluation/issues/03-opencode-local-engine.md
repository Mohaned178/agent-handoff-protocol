# 03: OpenCode on a local engine

**Implement with:** Opus 5.5, effort high

**What to build:** Let an OpenCode step use a local OpenAI-compatible engine, so `ahp eval` measures each engine's
verified success on the pilot tasks.

**Blocked by:** 00's spike (OpenCode must be able to drive at least one engine)

**Status:** open

- [ ] `opencode({ localEndpoint: { baseURL, models } })`:
  - adds a `provider.ahp-local` block (`@ai-sdk/openai-compatible`) to `OPENCODE_CONFIG_CONTENT`
  - `permission` stays exactly as the capabilities made it
  - the model is `ahp-local/<id>`
- [ ] The engine (name, URL, version from `/v1/models` or `/version`) recorded per trial beside the tool versions
- [ ] `pilot/local/`: one suite per engine with the same tasks, conditions and seed
- [ ] `ahp bench report --eval <dir>...`: each engine's verified success beside its speed, compared task by task
- [ ] Tests: provider block merged and permissions unchanged, against the fake `opencode`
