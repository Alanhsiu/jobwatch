#!/usr/bin/env python3
"""Backfill `t` (last change) and `h` (stage history) on legacy status.json marks from git history.

    python3 tools/backfill_marks.py            # print what would change
    python3 tools/backfill_marks.py --write    # rewrite status.json (sorted keys, indent=1); then commit it

One-off and user-run: the bot never writes status.json. Idempotent — an existing `t` or `h` is never
overwritten, so re-running after devices have edited marks changes nothing.
"""

import argparse
import json
import os
import subprocess
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import jobwatch  # noqa: E402


def git(repo, *args) -> str:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout


def stage(entry):
    s = entry if isinstance(entry, str) else entry.get("s") if isinstance(entry, dict) else None
    return s if s in jobwatch.STAGES else None


def history(repo):
    """Walk every commit touching status.json, oldest first.

    Returns (stage history per id, last-change time per id, first commit time, skipped commits).
    """
    log = git(repo, "log", "--reverse", "--format=%H %ct", "--", "status.json")
    prev, hist, last_change, first_ct, skipped = {}, defaultdict(list), {}, None, []
    for line in log.splitlines():
        sha, ct = line.split()
        ct = int(ct)
        first_ct = first_ct or ct
        try:
            snap = json.loads(git(repo, "show", f"{sha}:status.json"))
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            skipped.append(sha[:7])
            continue
        if not isinstance(snap, dict):
            skipped.append(sha[:7])
            continue
        for rid, entry in snap.items():
            if (rid not in prev or stage(prev[rid]) != stage(entry)) and stage(entry):
                hist[rid].append({"s": stage(entry), "t": ct})
            if prev.get(rid) != entry:
                last_change[rid] = ct
        prev = snap
    return hist, last_change, first_ct, skipped


def backfill(status, hist, last_change, first_ct):
    """Return (new status dict, ids changed). Live marks only; existing t/h kept verbatim."""
    out, changed = {}, []
    for rid, entry in status.items():
        entry = {"s": entry} if isinstance(entry, str) else dict(entry) if isinstance(entry, dict) else entry
        out[rid] = entry
        if not isinstance(entry, dict) or "d" in entry or first_ct is None:
            continue
        before = dict(entry)
        entry.setdefault("t", last_change.get(rid, first_ct))
        if "h" not in entry and hist.get(rid):
            entry["h"] = hist[rid][-12:]
        if entry != before:
            changed.append(rid)
    return out, changed


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--write", action="store_true", help="rewrite status.json (default: print the diff only)")
    p.add_argument("--repo", default=".", help="repository root holding status.json (default .)")
    args = p.parse_args(argv)
    path = os.path.join(args.repo, "status.json")
    status = jobwatch.load_json(path, dict, None)
    if status is None:
        print(f"[error] {path} not found", file=sys.stderr)
        return 1
    hist, last_change, first_ct, skipped = history(args.repo)
    out, changed = backfill(status, hist, last_change, first_ct)
    for sha in skipped:
        print(f"[note] skipped unparsable commit {sha}")
    for rid in changed:
        print(f"{rid}: {json.dumps(status[rid], ensure_ascii=False)} -> {json.dumps(out[rid], ensure_ascii=False)}")
    gain_h = sum(1 for rid in changed if "h" in out[rid] and "h" not in (status[rid] if isinstance(status[rid], dict) else {}))
    print(f"{len(changed)} of {len(status)} marks change ({gain_h} gain h) — "
          + ("written" if args.write else "dry run; pass --write to apply"))
    if args.write and changed:
        jobwatch.atomic_write(path, json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
