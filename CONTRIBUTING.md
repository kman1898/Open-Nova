# Contributing to Open Nova

Open Nova is an open-source app for NovaStar LED processors: layout mapping, Send and Save, redundancy, colour,
monitoring and diagnostics for the NovaLCT family (H series, VX, MCTRL), VX Pro (Unico) and MX / CX (COEX). It is a
browser page plus two small Python programs, and it runs on Windows, macOS and Linux.

Help is welcome, from a typo to a whole processor family. The most useful help right now is a
[problem report](https://github.com/kman1898/Open-Nova/issues/new/choose) from a real processor: see
[Report a problem](README.md#report-a-problem).

## Get it running

You need Python 3.9 or newer. For the plan tests you also need node; for the browser test pages, Playwright.

```sh
git clone https://github.com/kman1898/Open-Nova && cd Open-Nova
python3 opennova.py                  # the app opens in your browser (Windows: py -3 opennova.py)
python3 tools/run_tests.py           # every Python and node test
python3 tools/browser_tests.py       # the browser pages (pip install playwright; python -m playwright install chromium)
```

`opennova.py --local-only --data-dir <folder>` keeps a test project away from your real one. More options are in
[docs/RUNNING.md](docs/RUNNING.md).

## How the code is laid out

- `app/` — the page: `index.html`, `app.css`, `js/` (one file per area: `app-core.js` for the project, `app-render.js`
  and `app-autowire.js` for the layout, `app-screen.js`, `app-redundancy.js`, `app-health.js` …, and one driver per
  processor family behind `drv-core.js`: `drv-lct.js`, `drv-unico.js`, `drv-coex.js`, `drv-offline.js`), `scr.js` /
  `scfg.js` (NovaLCT files), `hwsend.js` (the Send plans). `app/serve.py` serves the page and keeps the projects; `app/serve.ps1` is the same server
  for Windows PowerShell.
- `tools/` — the hardware helper: `novalink.py` (the NovaLCT protocol, and the routes for the others), `unicolink.py`,
  `coexlink.py`, `hweb.py` (the H series web interface), `wirelog.py` (the recorder), the receiving-card file tools and
  the tests.
- `opennova.py` starts the helper and the server; the `Start Open Nova` files start `opennova.py`.

## Rules that aren't negotiable

1. **Never test on someone's show.** Tests run against stand-ins on 127.0.0.1 and the helper's simulated processor,
   never a real processor. If you try a change on your own hardware, do it on a wall you're allowed to change, away from
   an audience, and say so in the pull request.
2. **Nothing but the standard library at run time.** The helper and the server are Python 3.9 standard library; the page
   is plain JavaScript in the style of the file you're in (`var`, `function`, no build step, no frameworks, no packages
   fetched at run time). Test tools may use more (node, Playwright); the app may not.
3. **Windows, macOS and Linux.** Every change has to work on all three. Paths through `os.path`, no shell-only tricks,
   launchers with the right line endings (`.gitattributes`). A change to `app/serve.py` is made in `app/serve.ps1` too.
4. **Every processor conversation goes through the recorder** (`tools/wirelog.py`). A new link, route or transport
   records what it sends and receives, whole, so a problem report shows exactly what happened. Passwords, tokens and
   logins are never recorded or logged.
5. **Save is separate.** A Send never writes the processor's save; Save is always its own button.
6. **Seen working before it's switched on.** A write for a processor family is enabled only once it has been seen working
   on that family. Anything built from less is marked unverified and stays behind the capability gates.
7. **No vendor files or recordings in the repository.** No NovaStar software, libraries, firmware, documentation text,
   sample `.rcfgx` / `.ncp` / `.scr` / `.scfg` files, Wireshark captures, Open Nova recordings or project files, and
   nobody's IP addresses, show names or logins. `.gitignore` is a whitelist: a new file needs its own line, and
   `tools/test_repo_hygiene.py` fails on anything private. Describe processor behaviour in your own words.
8. **Every user action is logged** with the app's `log(...)`, so the report's timeline is complete.

## Writing for the interface

Plain and short. Hints go in tooltips, not on the page; the app is already busy, so fewer controls beat more. Processors
are called by their model, and "sending card" is only used where the hardware has them (H series, MX2000 Pro,
MX6000 Pro): `cardName()` and `portLabel()` pick the right words.

## Tests

| What | Run |
|---|---|
| Every Python and node test | `python3 tools/run_tests.py` (one: `--only <name>`) |
| The browser pages (app, modules, save rule, .scfg, UI sweep) | `python3 tools/browser_tests.py` |
| A package builds and starts | `python3 tools/make_package.py --out dist`, then `python3 tools/smoke_package.py dist/<zip>` |
| Syntax only | `node --check app/js/<file>.js`, `python3 -m py_compile tools/<file>.py` |

A test that needs private material (recordings, vendor samples) prints `SKIP` for that part and still runs the rest; CI
shows what it left out. Add a test for what you change: `tools/test_<name>.py` (standard library, `PASS` / `FAIL` lines),
`app/tests/<name>_test.js` (node) or a page in `app/tests/` added to `tools/browser_tests.py`. Whitelist a new test in
`.gitignore`. The details are in [docs/TESTING.md](docs/TESTING.md).

For a change you can see, run the UI sweep (`uiSweep()` from `app/tests/ui-lint.js`) at 375 to 1920 px wide, with the
menus open, in the light and the dark theme.

## Sending a change

1. For anything bigger than a bug fix, open an issue first so we can agree on the shape.
2. Branch from `main` and keep the pull request to one topic.
3. Run `python3 tools/run_tests.py` and `python3 tools/browser_tests.py` before you push. CI runs the same on Linux,
   macOS and Windows, and on Python 3.9.
4. Fill in the pull request template: what changed, what you ran, screenshots for anything visible, and whether it
   changes a default.
5. Don't push only to catch up with `main`; rebase when there is a conflict.

Checklist:

- [ ] Tests pass locally (`run_tests.py`, `browser_tests.py`).
- [ ] New files are in the `.gitignore` whitelist; nothing private in them.
- [ ] Standard library only at run time; works on Windows, macOS and Linux.
- [ ] New processor traffic goes through the recorder.
- [ ] Screenshots (narrow and wide, both themes) for UI changes.
- [ ] `Changes a default: no` (or what changes, and how to get the old behaviour back).

## Licence

Open Nova is MIT OR Apache-2.0. By contributing you agree that your contribution is licensed the same way, MIT OR
Apache-2.0, with no extra terms. There is no contributor licence agreement. Open Nova isn't affiliated with NovaStar;
product names are trademarks of their owners (see [NOTICE](NOTICE)).
