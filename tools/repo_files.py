"""repo_files.py - which files the repository holds (the .gitignore whitelist), for the guard tests (docs/TESTING.md).

    tracked()        -> sorted ['app/index.html', ...] (forward slashes, relative to the project folder)
    ignored(path)    -> True when .gitignore keeps path out of the repository (the file need not exist)

In a git checkout: git ls-files. In the working folder (not a repository): what `git add -A` would take, worked out by git
itself in a throwaway repository in the temp folder that points at this folder (nothing is written here). None when git
isn't installed: the caller skips.
"""
import os
import shutil
import subprocess
import tempfile

NOVA = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_GITDIR = []


def _git(*args):
    git = shutil.which('git')
    if not git: return None
    if os.path.isdir(os.path.join(NOVA, '.git')): pre = [git, '-C', NOVA]
    else:
        if not _GITDIR:
            d = tempfile.mkdtemp(prefix='opennova_repo_files_')
            subprocess.run([git, 'init', '-q', d], check=True, capture_output=True)
            _GITDIR.append(os.path.join(d, '.git'))
        pre = [git, '--git-dir=' + _GITDIR[0], '--work-tree=' + NOVA, '-C', NOVA]
    return subprocess.run(pre + ['-c', 'core.quotepath=off'] + list(args), capture_output=True)


def tracked():
    r = _git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
    if r is None: return None
    if r.returncode: raise RuntimeError(r.stderr.decode('utf-8', 'replace'))
    return sorted(p for p in r.stdout.decode('utf-8').split('\0') if p)


def ignored(path):
    r = _git('check-ignore', '-q', '--no-index', path)
    if r is None: return None
    return r.returncode == 0
