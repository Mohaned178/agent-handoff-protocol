# 03: Changing a step's tool, model and effort

**What to build:** A way to change who does a step before a one-command run starts, from the summary's menu or with
flags, and to keep a change as the default for next time.

**Blocked by:** 02

**Status:** planned

- [ ] Change something (the summary's menu): pick a step, then its tool, model and effort with the menus `ahp setup` has
      (`castRole` and the model list in `src/setup`); the summary is shown again with the change; Run starts it
- [ ] Flags: `--<step> <tool>`, `--<step>-model <name>`, `--<step>-effort <level>` for `plan`, `implement` and `review`
      (for example `--review claude-code --review-model opus`); a tool that is not usable, or an effort its tool does not
      have, is a usage error before anything runs
- [ ] Next time: after a change in the menu, "Use <tool> (<model>) for <step> next time? (y/N)"; yes writes
      `<AHP_HOME>/settings.json` (`{ steps: { review: { tool, model?, effort? } } }`), read by ticket 01's casting and
      shown as "(your default)"; a saved tool no longer usable falls back to the casting, and the summary says so
- [ ] `ahp settings` prints the saved defaults and the file's path; `ahp settings --clear` removes them
- [ ] Never read by `ahp eval` (spec D5) or by `ahp run <file>` (a file says its own casting)
- [ ] Tests: the menu path with a scripted person, every flag, a saved default used and one that fell back, `--clear`

## Notes

- Changing a step during a run is out of scope (spec): a handoff names its recipient when it is issued.
- The settings file holds names only (tool, model, effort), never a credential.
