## Change

What was wrong or missing, and what Open Nova does now. Link the issue (`Fixes #12`).

Changes a default: no

<!-- Required line. Replace "no" if this changes what a user gets out of the box (a default value, a setting, what a
button sends, the read-only alpha lock):
Changes a default: yes — <what>, the old behaviour kept behind <setting> -->

## Validation

- `python3 tools/run_tests.py`: <passed / skipped / failed counts>
- `python3 tools/browser_tests.py`: <result>
- Anything else you ran (a package with `make_package.py` + `smoke_package.py`, a stand-in, the UI sweep).

Talks to processors? Say which family, what goes on the wire (or "nothing changes on the wire"), that it goes through
the recorder, and whether it ran on real hardware (model, firmware) or only on stand-ins.

## Screenshots (for anything visible)

Before and after, narrow (375 px) and wide, in the light and the dark theme. Made-up projects only: no show names, client
names or real IP addresses. Attach them here rather than committing them.

## Checklist

- [ ] Tests pass locally
- [ ] New files are whitelisted in `.gitignore`, and nothing private is in them
- [ ] Standard library only at run time; Windows, macOS and Linux
- [ ] Save stays separate from Send
