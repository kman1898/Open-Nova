#!/bin/bash
# get-python.sh - macOS / Linux, first start without a usable Python: puts Python into <Open Nova folder>/python, so
# Open Nova runs with nothing to install by hand. Called by "Start Open Nova.command" / start-open-nova.sh only when no
# Python 3.9+ (with lzma) is found. Windows has its own: get-python.ps1. The macOS / Linux packages (make_package.py
# --python) carry the archives in python-dist/: then nothing is downloaded (a show site without internet works).
#
# What it takes: the "install_only_stripped" build of python-build-standalone (github.com/astral-sh/python-build-standalone,
# the relocatable CPython builds uv uses) for this computer, 27-37 MB, checked against the SHA-256 written below before
# it is unpacked. Nothing is installed: no installer, no admin password, no PATH change. Deleting the python folder removes
# it; the next start fetches it again. A newer one: change VERSION, RELEASE and the four sums together (the release's
# SHA256SUMS lists them) and run the test suite on it (tools/run_tests.py).
set -u
VERSION=3.14.10
RELEASE=20261026

here="$(cd "$(dirname "$0")/.." && pwd)" || exit 1
os="$(uname -s)"
arch="$(uname -m)"
# a Mac with Apple silicon running this under Rosetta still gets the native build
if [ "$os" = Darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then arch=arm64; fi
case "$os/$arch" in
  Darwin/arm64)                t=aarch64-apple-darwin;      sum=95eb8c87d16af37c54e9765e31d8c56c0d8ffa9968ea0f704f73a9b83f84e9f9 ;;
  Darwin/x86_64)               t=x86_64-apple-darwin;       sum=2fd8becd48cf0ff5f0a15df3c0db7cae7aa708dcaacf901bd30d6cdd6229370b ;;
  Linux/x86_64)                t=x86_64-unknown-linux-gnu;  sum=4d3c16c59ed0802a3d1d34d8bce504b15ceeaff39d62dadecc6a9fa803412aed ;;
  Linux/aarch64 | Linux/arm64) t=aarch64-unknown-linux-gnu; sum=90f48337bc3dd4ae6eda81e001e4c981236d403b6b5a07778bbdf94ee423dc00 ;;
  *) echo "There's no ready-made Python for $os $arch here: install Python 3.9 or newer (https://www.python.org/downloads/)"
     echo "and start Open Nova again."; exit 1 ;;
esac
file="cpython-$VERSION+$RELEASE-$t-install_only_stripped.tar.gz"
url="https://github.com/astral-sh/python-build-standalone/releases/download/$RELEASE/cpython-$VERSION%2B$RELEASE-$t-install_only_stripped.tar.gz"
work="$here/python-download"

fail() {
  echo
  echo "Couldn't get Python: $1"
  echo "Check the internet connection and start Open Nova again, or install Python 3 yourself from"
  echo "https://www.python.org/downloads/ and start again."
  rm -rf "$work"
  exit 1
}

rm -rf "$work"                                   # what an interrupted earlier try left
mkdir -p "$work" || fail "can't write in $here"
arc="$here/python-dist/$file"
if [ -f "$arc" ]; then
  echo "Setting up Python $VERSION ($t) from this package ..."
else
  arc="$work/$file"
  echo "Downloading Python $VERSION ($t) ..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "$arc" "$url" || fail "the download didn't finish"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$arc" "$url" || fail "the download didn't finish"
  else
    fail "this computer has neither curl nor wget"
  fi
fi
if command -v shasum >/dev/null 2>&1; then got="$(shasum -a 256 "$arc" | cut -d' ' -f1)"
else got="$(sha256sum "$arc" | cut -d' ' -f1)"; fi
[ "$got" = "$sum" ] || fail "$file isn't the file that was published (SHA-256 $got)"
tar -xzf "$arc" -C "$work" || fail "it couldn't be unpacked"
# macOS: files unpacked from a downloaded zip can carry the "downloaded from the internet" mark, and Gatekeeper then
# refuses the unsigned Python; this is the tester's own copy in their own folder, so the mark comes off it
if [ "$os" = Darwin ]; then xattr -dr com.apple.quarantine "$work/python" 2>/dev/null || true; fi
"$work/python/bin/python3" -c 'import lzma, ssl, ctypes' >/dev/null 2>&1 || fail "it doesn't start on this computer"
rm -rf "$here/python"
mv "$work/python" "$here/python" || fail "it couldn't be moved into $here/python"   # whole or not at all
rm -rf "$work"
echo "Python $VERSION is in $here/python"
