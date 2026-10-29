#!/bin/bash
# macOS: double-click to start Open Nova (first time: right-click > Open). Keep this window open while you work.
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then echo "Python 3 is needed: install it from https://www.python.org/downloads/ and double-click this again."; read -r -p "Press Return to close."; exit 1; fi
python3 opennova.py "$@"
status=$?
[ $status -ne 0 ] && read -r -p "Press Return to close."
exit $status
