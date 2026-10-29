Open Nova is open-source control for NovaStar LED processors: map a wall, send it, set up redundancy, adjust colour and
watch the wall's health. [Running it](https://github.com/kman1898/Open-Nova/blob/main/docs/RUNNING.md) ·
[what works](https://github.com/kman1898/Open-Nova/blob/main/README.md#what-works) ·
[roadmap](https://github.com/kman1898/Open-Nova/blob/main/ROADMAP.md) ·
[report a problem](https://github.com/kman1898/Open-Nova/issues/new/choose).

**Open Nova {version}.** The changes since the last release are listed below.

**Which file?**
- **OpenNova-{version}-alpha.zip**: the alpha for testers. It starts read-only: everything that writes to a processor
  needs the unlock code from whoever gave you the build. README-ALPHA.md is inside.
- **OpenNova-<date>.zip**: the same app without the alpha stamp.
- One zip runs on Windows, macOS and Linux. Unzip it, then double-click **Start Open Nova.bat** (Windows) or
  **Start Open Nova.command** (macOS), or run `./start-open-nova.sh` (Linux). It needs Python 3.9 or newer, nothing else.
- `SHA256SUMS.txt`: the SHA-256 of each zip (Linux: `sha256sum -c SHA256SUMS.txt --ignore-missing`).

Every package was unzipped and started on Linux, macOS and Windows before this release.

The downloads aren't signed yet. On Windows, if SmartScreen says "Windows protected your PC", choose **More info**, then
**Run anyway**. On macOS, right-click **Start Open Nova.command** and choose **Open** the first time.

Open Nova sends commands to live LED processors: check it on your equipment before a show
([DISCLAIMER.md](https://github.com/kman1898/Open-Nova/blob/main/DISCLAIMER.md)). Something wrong? **Help ▸ Report a
Problem…** in the app makes a zip to attach to an issue.
