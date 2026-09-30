"""Prune Cargo intermediates on macOS/Linux while holding Cargo's profile lock."""
import argparse
from contextlib import ExitStack
import os
import math
from pathlib import Path
import re
import shutil
import stat
import time


HASH = re.compile(r"-([0-9a-f]{16})(?:\.|$)")


def measure(path):
    """Allocated bytes and last use; never follow symlinks or refresh file atime."""
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        return info.st_blocks * 512, max(info.st_mtime, info.st_atime)
    size = info.st_blocks * 512
    used = info.st_mtime if stat.S_ISDIR(info.st_mode) else max(info.st_mtime, info.st_atime)
    if stat.S_ISDIR(info.st_mode):
        for child in path.iterdir():
            child_size, child_used = measure(child)
            size += child_size
            used = max(used, child_used)
    return size, used


def prune_profile(profile, budget, max_age, min_age, now, dry_run=False):
    groups = {}
    fingerprint = profile / '.fingerprint'
    if fingerprint.is_symlink():
        raise ValueError(f'Refusing symlink: {fingerprint}')
    if fingerprint.exists():
        for entry in fingerprint.iterdir():
            match = HASH.search(entry.name)
            if match:
                groups.setdefault(match[1], []).append(entry)
    # Remove a fingerprint together with its hashed outputs, so Cargo rebuilds it.
    for directory in [profile / 'deps', profile / 'build']:
        if directory.is_symlink():
            raise ValueError(f'Refusing symlink: {directory}')
        if directory.exists():
            for entry in directory.iterdir():
                match = HASH.search(entry.name)
                if match:
                    groups.setdefault(match[1], []).append(entry)
    candidates = list(groups.values())
    incremental = profile / 'incremental'
    if incremental.is_symlink():
        raise ValueError(f'Refusing symlink: {incremental}')
    if incremental.exists():
        candidates.extend([entry] for entry in incremental.iterdir())

    # Inspect before deletion. Unrecognized outputs and final binaries stay intact.
    total, _ = measure(profile)
    ranked = []
    for paths in candidates:
        measurements = [measure(path) for path in paths]
        ranked.append((max(used for _, used in measurements),
                       sum(size for size, _ in measurements), paths))
    removed = 0
    for used, size, paths in sorted(ranked, key=lambda item: item[0]):
        age = now - used
        if age < min_age or (age < max_age and total <= budget):
            continue
        for path in paths:
            if not dry_run:
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path)
                else:
                    path.unlink()
        removed += size
        total -= size
    action = 'would prune' if dry_run else 'pruned'
    print(f'[rust-cache] {action} {removed / 2**30:.2f} GiB from {profile}; '
          f'{total / 2**30:.2f} GiB retained')
    if total > budget:
        print('[rust-cache] size target exceeded; recent/final artifacts retained')
    return removed


def prune(target, budget, max_age, min_age, now, dry_run=False):
    # Only Cargo-marked profiles at the normal depth, including cross-compilation.
    if target.is_symlink():
        raise ValueError(f'Refusing symlink target: {target}')
    if not target.exists():
        return 0
    profiles = []
    for child in target.iterdir():
        if child.is_symlink() or not child.is_dir():
            continue
        if (child / '.cargo-lock').exists():
            profiles.append(child)
        else:
            for profile in child.iterdir():
                if not profile.is_symlink() and profile.is_dir() and (profile / '.cargo-lock').exists():
                    profiles.append(profile)
    import fcntl

    # Hold every discovered Cargo profile lock during sizing and deletion.
    # Skip the target if a compile is active; retry on the next pipeline invocation.
    with ExitStack() as locks:
        for profile in sorted(profiles):
            fd = os.open(profile / '.cargo-lock', os.O_RDWR | os.O_NOFOLLOW)
            lock = locks.enter_context(os.fdopen(fd, 'r+'))
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print(f'[rust-cache] busy, retained: {target}')
                return 0
        sizes = {profile: measure(profile)[0] for profile in profiles}
        total = sum(sizes.values())
        return sum(prune_profile(profile, budget * size / max(total, 1),
                                 max_age, min_age, now, dry_run)
                   for profile, size in sizes.items())



if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('targets', nargs='+', type=Path)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if os.name != 'posix':
        parser.exit(message='[rust-cache] automatic pruning supports macOS/Linux only\n')
    budget = float(os.environ.get('RUST_CACHE_MAX_GIB', '8')) * 2**30
    max_age = float(os.environ.get('RUST_CACHE_MAX_AGE_DAYS', '14')) * 86400
    min_age = float(os.environ.get('RUST_CACHE_MIN_AGE_HOURS', '24')) * 3600
    if not all(math.isfinite(value) for value in [budget, min_age, max_age]) or budget <= 0 or min_age < 0 or max_age < min_age:
        parser.error('Require positive RUST_CACHE_MAX_GIB and max age >= min age >= 0')
    if 'CARGO_TARGET_DIR' in os.environ and not Path(os.environ['CARGO_TARGET_DIR']).is_absolute():
        parser.error('Use an absolute CARGO_TARGET_DIR for automatic cleanup')
    targets = [Path(os.environ['CARGO_TARGET_DIR'])] if 'CARGO_TARGET_DIR' in os.environ else args.targets
    for target in dict.fromkeys(targets):
        prune(target.absolute(), budget, max_age, min_age, time.time(), args.dry_run)
