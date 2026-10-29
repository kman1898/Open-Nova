# Testing Open Nova

Everything below runs from the project folder on Windows, macOS and Linux. The app and every test runner need only
Python 3.9+ (and node for the plan tests); only the browser pages need Playwright, and only CI installs it.

## Run everything locally

| What | Command | Needs |
|---|---|---|
| Every Python and node test | `python tools/run_tests.py` | Python 3.9+, node |
| One test, or a few | `python tools/run_tests.py --only hygiene` (or `python -I -X utf8 tools/test_x.py`) | |
| The browser test pages | `python tools/browser_tests.py` | `pip install playwright` + `python -m playwright install chromium` |
| A package starts and serves | `python tools/make_package.py --out dist` then `python tools/smoke_package.py dist/OpenNova-<date>.zip` (`--alpha` for the alpha zip) | |
| Syntax only | `node --check app/js/x.js`, `python -m py_compile tools/x.py` | |

`run_tests.py` runs every `tools/test_*.py` (as `python -I -X utf8`) and every `app/tests/*_test.js` (node), one after
another, prints `PASS` / `SKIP` / `FAIL` per file and exits 1 if any file failed. `--list` shows what it would run,
`--json FILE` writes the results.

`browser_tests.py` starts its own app server (`app/serve.py --local-only`, a temporary data folder, a free port: never
`app/data` or the app on 8765) and opens `app_test.html`, `check-modules.html`, `save_rule_test.html`, `scfg_test.html`
and `ui_sweep.html` in headless Chromium, waits for each to finish and fails on any `FAIL` line, a `FAIL` title, a
script error or a time-out. `--pages a.html,b.html` picks pages, `--out DIR` keeps each page's text (and a screenshot of a
failed one). The app searches the network while it boots (before a page can stub it), so **outside CI the hardware
helper is not started** and nothing leaves the computer; `--helper` starts it (CI does: no processors there).
`hwsend_test.html` / `unicosend_test.html` are manual tools that send to a processor: never run automatically.

## Private data: SKIP, never FAIL, never silently

Recordings, captures, the vendor samples (`Samples/`, `app/samples/`, `app/out/scfg/`), the fakes and the research
tools stay out of the repository (`.gitignore` is a whitelist). A test that needs them:

- leaves that part out and prints `SKIP <what> (<why>)`, and still passes on the rest — `run_tests.py` lists every
  skipped part in its summary;
- or, when nothing at all can run without them, prints `SKIP <why>` and exits **77** (the file counts as skipped).

So the same test does more on the development computer than in CI, and CI shows exactly what it left out. Today:
`test_lct_color` (byte compare with NovaLCT's captures; the read-back runs on made-up records), `test_rcvguard` /
`test_rcvlib` (the real .rcfgx / .ncp files; the rules and the library run on made-up identities / stand-in files),
`test_wirelog` (the user's H recordings, the register table against the research doc), `scfg_test.html` (the real
.scfg / shows; the refusals run), `test_repo_hygiene` (show names and saved H logins are checked only where they exist).

## What CI does (`.github/workflows/`)

`ci.yml` — on every push to `main` / `alpha`, every pull request, by hand, and called by `release.yml`. A newer run for
the same branch cancels the older one; it can only read the repository.

| Job | Runs on | What |
|---|---|---|
| version-check | Linux | `tools/test_version.py`: `app/version.json` is the one version source; alpha.py, serve.py, serve.ps1, opennova.py and make_package.py agree with it, nothing else spells it out |
| lint | Linux | `node --check` every .js; every .py compiles and parses as Python 3.9; flake8 fatal errors (E9, F63, F7, F82) fail, style is advisory |
| lint-windows | Windows | Windows PowerShell 5.1 parses `app/serve.ps1` |
| test | Linux, macOS, Windows (Python 3.12) + Linux Python 3.9 | `tools/run_tests.py` |
| browser | Linux, 2 shards | `tools/browser_tests.py --helper --shard k/2` (ui_sweep takes a shard of its own) |
| build | Linux, pushes only | `make_package.py` and `make_package.py --alpha` (the shared unlock, `tools/alpha_unlock.json`; optional repository variable `OPENNOVA_REPORT_CONTACT`), reproducible from the commit time |
| smoke | Linux, macOS, Windows | each zip unzipped by the system's own tool, then `tools/smoke_package.py`: contents (licences, OFL texts, executable launchers, nothing private, the alpha stamp and unlock hashes), `opennova.py --no-browser` started, `/`, `/version.json`, `/api/projects`, `/js/app-core.js`, `/fonts/fonts.css`, a .woff2, `/api/hw/ping` and `/api/hw/diag/status` through the server, then stopped |

`release.yml` — on a tag `v*`: the tag must be `v` + `app/version.json`'s version, then all of `ci.yml`, then a GitHub
release with both zips and `SHA256SUMS.txt` (notes: `.github/release-notes.md` + the changes since the last release). A tag with `-alpha`, `-beta` or `-rc` is a pre-release and never "latest".
To release: set the version in `app/version.json`, push, then `git tag v<version> && git push origin v<version>`.

## The guard tests

- `test_repo_hygiene.py` — nothing private in a tracked file: the VM's addresses, 192.168.0.x other than the example
  placeholders, files under the private folders, recordings / captures / vendor files, mail addresses, user folders,
  saved logins (and, where this computer has an H login store, none of its values), names of the user's show / client
  sample files, citations of decompiled NovaStar code (`LCA:11512`, `SC:…`, `[C]`, "decompiled", `tools/re/`, .NET
  namespaces, `…Accessor` classes, vendor .dll names, a quoted `Class.Method`), names of the user's recordings outside the
  tests that open them (`redund_h20x4`, `lct-B.pcapng` …), and the private notes file `docs/CODE_SOURCES.md` (where those
  sources live now; a public comment says in plain words what the code does and why). Enforced since 2026-10-28. Also: every file the app loads (index.html's scripts
  and styles, the looks, fonts.css and its fonts with their OFL texts), the licences, everything `make_package.py`
  packs and every module the helper imports is in the repository.
- `test_version.py` — as in the table above.
- `test_workflows.py` — every file a workflow names exists and is tracked; every test file is run by a job
  (`run_tests.py` finds every `tools/test_*.py` / `app/tests/*_test.js`, every `app/tests/*.html` is in
  `browser_tests.PAGES` or `MANUAL`, the shards cover all pages); every `tools/test_*.py` on this computer is
  whitelisted; the jobs keep their shape (OSes, Python 3.9, permissions, pinned actions, pre-release rule, no secrets).

## Adding a test

- **Helper / server (Python)**: `tools/test_<name>.py`, stdlib only, `python -I -X utf8`-clean. Print `PASS …` / `FAIL …`
  per check, `SKIP …` for a part left out, exit 0 / 1 (77 = nothing could run). Use temporary folders
  (`OPENNOVA_DIAG`, `OPENNOVA_HELPER_LOGS`, `OPENNOVA_ALPHA_SETTINGS`, `OPENNOVA_LIBRARY`, `OPENNOVA_CONFIG_DIR`) and stand-ins
  on 127.0.0.1 — never a real processor. **Add it to the `.gitignore` whitelist** (`test_workflows` fails otherwise).
- **Plans (node)**: `app/tests/<name>_test.js`, prints `PASS` / `FAIL` lines, exits non-zero on a failure.
- **Browser page**: `app/tests/<name>.html` that sets `document.title` to `PASS …` / `FAIL …` when done and prints
  `PASS` / `FAIL` / `SKIP` lines; add it to `PAGES` in `tools/browser_tests.py` with a time limit (or to `MANUAL` with why).
- `run_tests.py` and the CI jobs pick new files up by themselves; run `python tools/run_tests.py` before pushing.
