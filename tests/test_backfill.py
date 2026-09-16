import json
import os
import sys

from conftest import FAKE_GIT_T0, ROOT, read_json

sys.path.insert(0, os.path.join(ROOT, "tools"))

import backfill_marks  # noqa: E402

T = [FAKE_GIT_T0 + i * 86400 for i in range(6)]


def test_sets_t_and_h_from_history(fake_git):
    repo, _ = fake_git
    assert backfill_marks.main(["--write", "--repo", repo]) == 0
    out = read_json(os.path.join(repo, "status.json"))
    assert out["a"] == {"s": "interview", "t": T[4], "h": [{"s": "seen", "t": T[0]}, {"s": "applied", "t": T[2]}, {"s": "interview", "t": T[4]}]}
    assert out["c"] == {"s": "dropped", "t": T[4], "h": [{"s": "dropped", "t": T[4]}]}
    assert out["d"] == {"s": "applied", "t": 1, "h": [{"s": "applied", "t": 1}]}  # existing t/h untouched
    assert list(out) == sorted(out)


def test_idempotent(fake_git):
    repo, _ = fake_git
    backfill_marks.main(["--write", "--repo", repo])
    first = open(os.path.join(repo, "status.json"), "rb").read()
    backfill_marks.main(["--write", "--repo", repo])
    assert open(os.path.join(repo, "status.json"), "rb").read() == first
    _, changed = backfill_marks.backfill(json.loads(first), *backfill_marks.history(repo)[:3])
    assert changed == []


def test_skips_unparsable_commit(fake_git, capsys):
    repo, _ = fake_git
    hist, last_change, first_ct, skipped = backfill_marks.history(repo)
    assert len(skipped) == 1 and first_ct == T[0]
    assert hist["a"] == [{"s": "seen", "t": T[0]}, {"s": "applied", "t": T[2]}, {"s": "interview", "t": T[4]}]
    backfill_marks.main(["--repo", repo])
    assert "[note] skipped unparsable commit" in capsys.readouterr().out


def test_star_only_change_updates_t_not_h(fake_git):
    repo, _ = fake_git
    backfill_marks.main(["--write", "--repo", repo])
    out = read_json(os.path.join(repo, "status.json"))
    assert out["b"] == {"s": "applied", "star": True, "t": T[2], "h": [{"s": "applied", "t": T[1]}]}


def test_dry_run_prints_diff_without_write(fake_git, capsys):
    repo, _ = fake_git
    before = open(os.path.join(repo, "status.json"), "rb").read()
    assert backfill_marks.main(["--repo", repo]) == 0
    out = capsys.readouterr().out
    assert open(os.path.join(repo, "status.json"), "rb").read() == before
    assert '"a": ' not in out and 'a: {"s": "interview"} -> {"s": "interview", "t":' in out
    assert "3 of 4 marks change (3 gain h) — dry run; pass --write to apply" in out


def test_legacy_string_and_tombstone(fake_git):
    repo, _ = fake_git
    hist, last_change, first_ct, _ = backfill_marks.history(repo)
    out, changed = backfill_marks.backfill({"a": "applied", "z": {"d": 5}, "q": {"s": "oa"}}, hist, last_change, first_ct)
    assert out["a"]["s"] == "applied" and out["a"]["t"] == T[4] and out["a"]["h"] == hist["a"]
    assert out["z"] == {"d": 5}
    assert out["q"] == {"s": "oa", "t": T[0]} and set(changed) == {"a", "q"}  # unknown id: t = first commit, no history
