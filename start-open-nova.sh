#!/bin/bash
# Linux: run ./start-open-nova.sh (or double-click in a file manager that runs scripts). Keep this window open while you work.
# No usable Python? The first start puts one into this folder (tools/get-python.sh): nothing to install.
cd "$(dirname "$0")" || exit 1
unset PYTHONHOME PYTHONPATH   # a Python set up for something else must not steer ours

works() { "$@" -c 'import sys, lzma; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; }

PY=
if [ -x "$PWD/python/bin/python3" ] && works "$PWD/python/bin/python3"; then PY="$PWD/python/bin/python3"
elif ! ls python-dist/*.tar.gz >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 && works python3; then PY=python3   # the package's own Python first
else
  if ls python-dist/*.tar.gz >/dev/null 2>&1; then
    echo "Setting up Open Nova's own Python in this folder (only this once, a few seconds)."
  else
    echo "Open Nova needs Python. Getting it into this folder (about 35 MB, only this once)."
  fi
  echo "Nothing is installed on this computer; it stays in the \"python\" folder here."
  echo
  if bash tools/get-python.sh; then PY="$PWD/python/bin/python3"
  elif command -v python3 >/dev/null 2>&1 && works python3; then echo; echo "Using this computer's own Python instead."; PY=python3   # the package's own didn't set up
  else read -r -p "Press Return to close."; exit 1; fi
  echo
fi
"$PY" opennova.py "$@"
status=$?
[ $status -ne 0 ] && read -r -p "Press Return to close."
exit $status
