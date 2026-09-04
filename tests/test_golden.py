"""Golden test: the real five state files + the fixture feed, clock frozen — what C1 guarantees."""

import os

import jobwatch
from conftest import EXPECTED, FROZEN_NOW, REAL, STATE_FILES, VECTORS, read_json, snapshot, write_json

V1_KEYS = {"id", "company", "title", "location", "url", "category", "posted", "date_posted", "active", "first_seen", "last_seen"}
IDENTITY = ("id", "company", "title", "url", "date_posted", "first_seen")


def test_golden_real_state_round_trip(state_dir, feed_subset, http, clock, tmp_path):
    prev = {r["id"]: r for r in read_json(os.path.join(REAL, "roles.json"))}
    golden = EXPECTED["golden"]
    assert len(prev) == golden["roles"] == 480
    feed_path = str(tmp_path / "golden_feed.json")
    write_json(feed_path, [r for r in feed_subset if "simplify:" + r.get("id", "") in prev])
    live = {"simplify:" + r["id"]: r for r in read_json(feed_path) if r.get("active") and r.get("is_visible", True)}
    before = snapshot(state_dir)
    rt = jobwatch.Runtime(now=FROZEN_NOW, env={}, urlopen=http.urlopen, sleep=clock.sleep, monotonic=clock.monotonic)

    # 1. dry run: nothing written, every file byte-identical
    assert jobwatch.run(jobwatch.parse_args(["--dry-run", "--feed", feed_path, "--state-dir", state_dir]), rt) == 0
    assert snapshot(state_dir) == before

    # 2. real run without creds: the page-owned files never change; seen.json only gains the silently-known ids
    assert jobwatch.run(jobwatch.parse_args(["--feed", feed_path, "--state-dir", state_dir]), rt) == 0
    after = snapshot(state_dir)
    for name in ("status.json", "companies.json", "manual.json"):
        assert after[name] == before[name], name
    seen_before = set(read_json(os.path.join(REAL, "seen.json")))
    seen_after = set(read_json(os.path.join(state_dir, "seen.json")))
    assert seen_after == seen_before | set(golden["known_silent"])
    assert len(golden["known_silent"]) == 5 and golden["new_ids"] == []

    rows = {r["id"]: r for r in read_json(os.path.join(state_dir, "roles.json"))}
    assert set(rows) == set(prev)  # all 480 ids present, nothing pruned
    cfg = jobwatch.load_config(os.path.join(state_dir, "config.json"))[0]
    keywords = jobwatch.keyword_list(read_json(os.path.join(REAL, "companies.json")), [])
    for rid, row in rows.items():
        old = prev[rid]
        assert all(row[k] == old[k] for k in IDENTITY), rid
        assert V1_KEYS <= set(row), rid
        assert jobwatch.re.fullmatch(r"\d{4}-\d{2}-\d{2}", row["posted"]), rid
        assert row["group"] == jobwatch.group_key(row["company"], row["title"])
        if rid in live:
            role = jobwatch.normalize_record(live[rid])
            passes = bool(jobwatch.match_company(role["company"], keywords, cfg.deny)) and jobwatch.classify(role, cfg, prev, FROZEN_NOW) is None
            assert row["active"] is passes, (rid, row["title"])
            assert row["in_feed"] is True
            if not passes:
                assert row["reason"] == "untracked" and row["why"] in ("phd", "title", "region", "category", "sponsorship", "company"), rid
        else:
            assert row["active"] is False and row["in_feed"] is False and row["reason"] == "closed", rid
        if old["active"] and not row["active"]:
            assert row["closed_at"] == FROZEN_NOW and row["last_seen"] == FROZEN_NOW
        elif not old["active"] and not row["active"]:
            assert row["last_seen"] == old["last_seen"] and row["closed_at"] == int(old["last_seen"])

    # the measured flips, enumerated
    untracked = {rid: rows[rid]["why"] for rid in prev if prev[rid]["active"] and not rows[rid]["active"] and rows[rid]["in_feed"]}
    closed = sorted(rid for rid in prev if prev[rid]["active"] and not rows[rid]["active"] and not rows[rid]["in_feed"])
    reactivated = sorted(rid for rid in prev if not prev[rid]["active"] and rows[rid]["active"])
    assert untracked == golden["untracked"] and len(untracked) == 60
    assert closed == golden["closed"] and len(closed) == 9
    assert reactivated == golden["reactivated"] and len(reactivated) == 13
    assert sum(1 for r in rows.values() if r["active"]) == golden["active"] == 308 - 60 - 9 + 13

    # keep-marked rows are all present and none of them left the active set
    marks = jobwatch.parse_marks(read_json(os.path.join(REAL, "status.json")))
    keep = {i for i in marks if jobwatch.has_keep_mark(marks, i, cfg.keep_marks)}
    assert len(keep) == 73 and len(keep & set(prev)) == 72 and keep - set(prev) == {"manual:mrx6adqyn8q7"}
    assert sorted(keep & set(prev)) == golden["keep_marked"]
    assert all(rows[i]["active"] for i in keep & set(prev) if prev[i]["active"])
    assert len(marks) == 170 and all({k for k in m} <= {"s", "star", "note", "t", "h"} for m in marks.values())
    raw = read_json(os.path.join(REAL, "status.json"))
    assert all(marks[i].get("s") == raw[i].get("s") and marks[i].get("star") == raw[i].get("star") for i in raw)

    assert len(keywords) == len({jobwatch.norm(k) for k in read_json(os.path.join(REAL, "companies.json"))} - {""}) == golden["keywords"]
    assert "d matrix" in keywords and "d-matrix" not in keywords

    meta = read_json(os.path.join(state_dir, "meta.json"))
    assert meta["counts"]["untracked_this_run"] == 60 and meta["counts"]["closed_this_run"] == 9
    assert meta["counts"]["silent_known_this_run"] == 5 and meta["counts"]["new_this_run"] == 0
    assert meta["keywords"]["millennium"] == {"active": 0, "all_time": 1, "names": [], "denied": 1}
    assert meta["keywords"]["tiktok"]["names"] == ["TikTok"] and meta["keywords"]["tiktok"]["active"] > 90
    assert meta["last_result"] == "ok" and meta["telegram"]["mode"] == "none"


def test_golden_status_parse_vectors():
    table = VECTORS["parse_marks"]
    assert len(table) == 12
    parsed = jobwatch.parse_marks({case["id"]: case["in"] for case in table})
    for case in table:
        assert parsed.get(case["id"]) == case["out"], case["label"]
    assert sum(1 for case in table if case["out"] is None) >= 3
    assert any(case["out"] == {"d": 1788000000} for case in table)
    real = jobwatch.parse_marks(read_json(os.path.join(REAL, "status.json")))
    assert len(real) == 170 and sum(1 for m in real.values() if m.get("star")) == 2


def test_fixture_files_are_untouched_copies():
    for name in STATE_FILES:
        assert os.path.exists(os.path.join(REAL, name)), name
    assert EXPECTED["frozen_now"] == FROZEN_NOW == 1788586400
