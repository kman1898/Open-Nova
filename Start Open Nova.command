#!/bin/bash
# macOS: double-click to start Open Nova (first time: right-click > Open; macOS 15+: System Settings > Privacy & Security >
# Open Anyway). Keep this window open while you work.
# No usable Python? The first start puts one into this folder (tools/get-python.sh): nothing to install.
cd "$(dirname "$0")" || exit 1
unset PYTHONHOME PYTHONPATH   # a Python set up for something else must not steer ours

works() { "$@" -c 'import sys, lzma; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; }
# macOS's /usr/bin/python3 is only a placeholder until Apple's developer tools are installed: running it opens Apple's
# install dialog (a large download), so it is only tried when those tools are there
system_ok() {
  command -v python3 >/dev/null 2>&1 || return 1
  if [ "$(command -v python3)" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1; then return 1; fi
  works python3
}

PY=
if [ -x "$PWD/python/bin/python3" ] && works "$PWD/python/bin/python3"; then PY="$PWD/python/bin/python3"
elif ! ls python-dist/*.tar.gz >/dev/null 2>&1 && system_ok; then PY=python3   # the package's own Python first
else
  if ls python-dist/*.tar.gz >/dev/null 2>&1; then
    echo "Setting up Open Nova's own Python in this folder (only this once, a few seconds)."
  else
    echo "Open Nova needs Python. Getting it into this folder (about 27 MB, only this once)."
  fi
  echo "Nothing is installed on the Mac; it stays in the \"python\" folder here."
  echo
  if bash tools/get-python.sh; then PY="$PWD/python/bin/python3"
  elif system_ok; then echo; echo "Using this computer's own Python instead."; PY=python3   # the package's own didn't set up
  else read -r -p "Press Return to close."; exit 1; fi
  echo
  # macOS 15 may name Terminal instead of Python in its question: the words fit both
  echo "When macOS asks whether Python or Terminal may find devices on your local network, or accept incoming"
  echo "connections: click Allow. Without that Open Nova can't find your processors. Clicked Don't Allow? System Settings >"
  echo "Privacy & Security > Local Network: switch on Terminal (or Python)."
  echo
fi
# the Mac package's libusb (NovaStar USB): a downloaded zip marks every file "from the internet", and macOS then refuses to
# load the unsigned library; this is the tester's own copy in their own folder, so the mark comes off it (as for python/)
if [ -d libusb ]; then xattr -dr com.apple.quarantine libusb 2>/dev/null || true; fi
"$PY" opennova.py "$@"
status=$?
[ $status -ne 0 ] && read -r -p "Press Return to close."
exit $status
