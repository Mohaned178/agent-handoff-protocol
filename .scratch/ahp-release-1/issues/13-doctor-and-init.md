# 13: `ahp doctor` and `ahp init`

**What to build:** A developer runs `ahp doctor` to learn what they can use on this machine, and `ahp init` to get a working example workflow: the password-reset reference scenario.

**Blocked by:** 10, 11

**Status:** ready-for-agent

**Model:** Sonnet 5.5 · medium

- [ ] `doctor` reports OS, Node and git versions against requirements
- [ ] `doctor` reports each of the four tools: installed, version, logged in (as far as the tool reveals), and capabilities with enforcement level on this OS
- [ ] `doctor` flags tools that need paid access (Gemini CLI)
- [ ] `doctor` never reads or prints credentials
- [ ] `init` writes the reference scenario: plan → implement (hidden tests) → review (send-back) → approval gate → push or PR, using only tools `doctor` found, falling back to the mock adapter
- [ ] The generated workflow passes static validation and runs end to end with the mock adapter

## Implementer notes

- Detect login only through each tool's own status or version commands; never send a prompt (it would spend the user's usage), and never open, parse or print credential or token files.
- If a tool gives no way to tell, report "login: unknown" rather than guessing.
- Test `init` by running its generated workflow end to end with the mock adapter in the test suite.
