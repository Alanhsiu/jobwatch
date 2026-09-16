"""End-to-end runs of jobwatch.run() on the fixture feed with fakes for clock, network and Telegram."""

import inspect
import os
import urllib.error

import pytest

import jobwatch
from conftest import CREDS, EXPECTED, FROZEN_NOW, SMALL_FEED_CONFIG, read_json, snapshot, write_json

ACTIONS = {"GITHUB_ACTIONS": "true"}
GOLDEN = EXPECTED["golden"]
SUBSET = EXPECTED["subset"]
NVIDIA_B = "simplify:fb8993b6-84c3-4607-801f-ed29b702f2f8"
TESLA_C = "simplify:bf15bc13-29b7-40a4-83f5-9a809a1d744e"
VIRTU = next(i for i in SUBSET["known_silent"] if i.startswith("simplify:f65657ff"))
HOUR = 3600


def rows(state_dir):
    return {r["id"]: r for r in read_json(os.path.join(state_dir, "roles.json"))}


def seen(state_dir):
    return set(read_json(os.path.join(state_dir, "seen.json")))


def meta(state_dir):
    return read_json(os.path.join(state_dir, "meta.json"))


def set_config(state_dir, **top):
    cfg = dict(SMALL_FEED_CONFIG)
    cfg.update(top)
    write_json(os.path.join(state_dir, "config.json"), cfg)


def set_companies(state_dir, keywords):
    write_json(os.path.join(state_dir, "companies.json"), keywords)


def drop_keyword(state_dir, kw):
    set_companies(state_dir, [k for k in read_json(os.path.join(state_dir, "companies.json")) if k != kw])


def feed_path(tmp_path, records, name="feed.json"):
    path = str(tmp_path / name)
    write_json(path, records)
    return path


def telegram(cfg_extra=None, **over):
    tg = dict(jobwatch.DEFAULT_CONFIG["telegram"], **over)
    return dict(cfg_extra or {}, telegram=tg)


def multi_chunk(state_dir):
    """Force the fixture's new roles into several Telegram chunks (the exact count is not what is under test)."""
    set_config(state_dir, **telegram(chunk_chars=2200))


def changed_files(before, after):
    return {n for n in set(before) | set(after) if before.get(n) != after.get(n)}


def would_write(out):
    """File names from the dry run's "[dry-run] would write: ..." line, in the order printed ([] for "nothing")."""
    names = jobwatch.re.search(r"^\[dry-run\] would write: (.*)$", out, jobwatch.re.M).group(1)
    return [] if names == "nothing" else names.split(", ")


# ── first run / delivery accounting ─────────────────────────────────────────

def test_first_run_seeds_only_if_summary_delivered(bot, state_dir, http):
    os.remove(os.path.join(state_dir, "seen.json"))
    http.telegram = [("http", 400, {"description": "Bad Request: chat not found"})] * 2
    assert bot(env=CREDS) == 3
    assert not os.path.exists(os.path.join(state_dir, "seen.json"))
    assert os.path.exists(os.path.join(state_dir, "roles.json")) and meta(state_dir)["telegram"]["mode"] == "failed"
    http.telegram = ["ok"]
    assert bot(env=CREDS) == 0
    assert seen(state_dir) == {i for i, r in rows(state_dir).items() if r["active"]}
    assert http.telegram_texts()[-1].startswith("<b>jobwatch is live.</b> Watching")


def test_first_run_no_creds_does_not_seed(bot, state_dir, http, capsys):
    write_json(os.path.join(state_dir, "seen.json"), [])
    assert bot() == 0
    assert read_json(os.path.join(state_dir, "seen.json")) == []  # untouched
    assert http.calls == [] and "No Telegram creds" in capsys.readouterr().out
    assert meta(state_dir)["telegram"]["mode"] == "no_creds"


def test_new_ids_only_delivered_join_seen(bot, state_dir, http):
    multi_chunk(state_dir)
    http.telegram = ["ok"] + [("http", 403, {})] * 9
    before = seen(state_dir)
    assert bot(env=CREDS) == 0
    delivered = seen(state_dir) - before - set(SUBSET["known_silent"])
    assert delivered and delivered < set(SUBSET["new_ids"])
    assert len(http.telegram_texts()) >= 2
    for rid in delivered:
        assert rows(state_dir)[rid]["url"] in http.telegram_texts()[0]


def test_partial_chunk_failure_exit_0_warning_seen_excludes_failed(bot, state_dir, http, capsys):
    multi_chunk(state_dir)
    http.telegram = ["ok"] + [("http", 500, {})] * 30
    assert bot(env=dict(CREDS, **ACTIONS)) == 0
    out = capsys.readouterr().out
    n = meta(state_dir)["telegram"]["failed_chunks"] + 1
    assert f"::warning::telegram chunk 2/{n} failed: HTTP 500 after 2 retries" in out and "re-announced next run" in out
    failed_ids = {rid for rid in SUBSET["new_ids"] if rid not in seen(state_dir)}
    assert failed_ids and all(rows(state_dir)[rid]["url"] not in http.telegram_texts()[0] for rid in failed_ids)
    assert meta(state_dir)["last_result"] == "telegram-partial" and meta(state_dir)["telegram"]["failed_chunks"] == n - 1


def test_all_chunks_failed_exit_3_files_written(bot, state_dir, http, capsys):
    multi_chunk(state_dir)
    http.telegram = [("http", 401, {})] * 9
    before = snapshot(state_dir)
    assert bot(env=dict(CREDS, **ACTIONS)) == 3
    n = len(http.telegram_texts())
    assert n >= 2 and f"::error::telegram: all {n} chunks failed: HTTP 401 unauthorized" in capsys.readouterr().out
    after = snapshot(state_dir)
    assert after["roles.json"] != before["roles.json"] and "meta.json" in after
    assert not set(SUBSET["new_ids"]) & seen(state_dir)
    assert set(SUBSET["known_silent"]) <= seen(state_dir)
    assert meta(state_dir)["last_result"] == "telegram-failed"


def test_no_creds_not_marked_seen_loud_line(bot, state_dir, http, capsys):
    assert bot() == 0
    out = capsys.readouterr().out
    assert f"[warn] No Telegram creds: {len(SUBSET['new_ids'])} new role(s) printed below and NOT marked seen" in out
    assert not set(SUBSET["new_ids"]) & seen(state_dir) and http.calls == []
    assert rows(state_dir)[SUBSET["new_ids"][0]]["url"] in out


def test_no_notify_marks_seen(bot, state_dir, http):
    set_config(state_dir, **telegram(max_messages_per_run=1, chunk_chars=1500))
    assert bot("--no-notify", env=CREDS) == 0
    assert set(SUBSET["new_ids"]) <= seen(state_dir) and http.calls == []
    assert meta(state_dir)["telegram"]["mode"] == "no_notify"


def test_dry_run_writes_nothing_sends_nothing(bot, state_dir, http, capsys):
    before = snapshot(state_dir)
    assert bot("--dry-run", env=CREDS) == 0
    out = capsys.readouterr().out
    assert snapshot(state_dir) == before and http.calls == []
    assert jobwatch.re.search(r"\[dry-run\] would send [1-9] chunk\(s\)", out)
    assert would_write(out) == ["roles.json", "README.md", "seen.json", "meta.json"]
    assert "[dry-run]" in out.splitlines()[-1]


@pytest.mark.parametrize("env", [CREDS, {}], ids=["creds", "no_creds"])
def test_dry_run_preview_matches_real_run(bot, state_dir, http, capsys, env):
    """--dry-run names exactly the files the identical real run then changes (§7.9): seen.json whenever ids would be
    marked seen (delivered with creds, known-silent without) and meta.json whenever it is due; the unchanged
    follow-up previews nothing."""
    before = snapshot(state_dir)
    assert bot("--dry-run", env=env) == 0
    predicted = would_write(capsys.readouterr().out)
    assert predicted == ["roles.json", "README.md", "seen.json", "meta.json"] and snapshot(state_dir) == before
    assert bot(env=env) == 0
    assert changed_files(before, snapshot(state_dir)) == set(predicted)
    assert bot("--dry-run", env=env, now=FROZEN_NOW + 3 * HOUR) == 0
    assert would_write(capsys.readouterr().out) == []


def test_dry_run_first_run_without_creds_previews_no_seed(bot, state_dir, capsys):
    """A first run without creds is not seeded (§7.7), so its preview must not list seen.json either."""
    write_json(os.path.join(state_dir, "seen.json"), [])
    before = snapshot(state_dir)
    assert bot("--dry-run") == 0
    predicted = would_write(capsys.readouterr().out)
    assert predicted == ["roles.json", "README.md", "meta.json"] and snapshot(state_dir) == before
    assert bot() == 0
    assert changed_files(before, snapshot(state_dir)) == set(predicted)


def test_max_messages_per_run_caps_delivery(bot, state_dir, http):
    set_config(state_dir, **telegram(max_messages_per_run=1, chunk_chars=1500))
    assert bot(env=CREDS) == 0
    texts = http.telegram_texts()
    assert len(texts) == 1 and "more roles — open the tracker" in texts[0]
    delivered = set(SUBSET["new_ids"]) & seen(state_dir)
    cut = set(SUBSET["new_ids"]) - seen(state_dir)
    assert delivered and cut and meta(state_dir)["telegram"]["delivered"] == len(delivered)
    assert all(rows(state_dir)[rid]["url"] not in texts[0] for rid in cut)


# ── matching semantics through the whole run ────────────────────────────────

def test_sticky_once_tracked_skips_age(bot, state_dir, feed_subset):
    assert bot("--no-notify") == 0
    r = rows(state_dir)
    assert r[NVIDIA_B]["active"] is True and FROZEN_NOW - r[NVIDIA_B]["date_posted"] > 75 * 86400
    aged = [x for x in feed_subset if x.get("active") and "simplify:" + x["id"] not in r
            and FROZEN_NOW - x["date_posted"] > 75 * 86400 and jobwatch.match_company(x["company_name"], [jobwatch.norm(x["company_name"])], [])]
    assert aged and meta(state_dir)["rejects"]["age"] >= 1


def test_reactivated_role_not_renotified(bot, state_dir, http):
    assert bot(env=CREDS) == 0
    assert rows(state_dir)[NVIDIA_B]["active"] is True and NVIDIA_B in seen(state_dir)
    assert all(rows(state_dir)[NVIDIA_B]["url"] not in t for t in http.telegram_texts())
    assert NVIDIA_B not in SUBSET["new_ids"]


def test_untracked_vs_closed_with_why(bot, state_dir):
    assert bot("--no-notify") == 0
    r = rows(state_dir)
    tesla = r[TESLA_C]
    assert tesla["active"] is False and tesla["in_feed"] is True and tesla["reason"] == "untracked" and tesla["why"] == "title"
    assert tesla["closed_at"] == FROZEN_NOW
    for rid in GOLDEN["closed"]:
        assert r[rid]["active"] is False and r[rid]["in_feed"] is False and r[rid]["reason"] == "closed"
        assert r[rid]["closed_at"] == FROZEN_NOW and "why" not in r[rid]
    assert {rid: r[rid]["why"] for rid in GOLDEN["untracked"]} == GOLDEN["untracked"]


def test_company_removed_marks_untracked_not_closed(bot, state_dir, capsys):
    drop_keyword(state_dir, "tiktok")
    assert bot("--no-notify") == 0
    tiktok = [r for r in rows(state_dir).values() if r["company"] == "TikTok" and r["in_feed"]]
    assert len(tiktok) > 100 and all(not r["active"] and r["reason"] == "untracked" and r["why"] == "company" for r in tiktok)
    assert not any(r["company"] == "TikTok" and r["reason"] == "closed" and r["closed_at"] == FROZEN_NOW
                   for r in rows(state_dir).values() if r["id"] not in GOLDEN["closed"])
    m = meta(state_dir)
    assert m["counts"]["closed_this_run"] == 9 and m["counts"]["untracked_this_run"] > 150
    assert "left your filters this run" in capsys.readouterr().err


def test_empty_companies_honoured_then_zero_match_gate(bot, state_dir, capsys):
    set_companies(state_dir, [])
    assert bot("--no-notify") == 0
    r = rows(state_dir)
    assert all(not x["active"] for x in r.values())
    assert all(x["why"] == "company" for x in r.values() if x["in_feed"])
    assert "companies.json is []" in capsys.readouterr().err
    assert meta(state_dir)["counts"]["untracked_this_run"] == 308 - 9


def test_zero_match_gate_exit_4(bot, state_dir, capsys):
    set_companies(state_dir, ["zzz-no-such-company"])
    before = snapshot(state_dir)
    assert bot("--no-notify") == 4
    assert snapshot(state_dir) == before
    assert "0 matches while 308 roles were active and 1 keywords are configured" in capsys.readouterr().err


def test_force_bypasses_gates(bot, state_dir):
    set_companies(state_dir, ["zzz-no-such-company"])
    assert bot("--no-notify", "--force") == 0
    assert all(not r["active"] for r in rows(state_dir).values())
    set_companies(state_dir, ["zzz-no-such-company"])
    assert bot("--no-notify", env={"JOBWATCH_FORCE": "1"}, now=FROZEN_NOW + HOUR) == 0


def test_companies_seeded_only_when_absent_with_notice(bot, state_dir, capsys):
    os.remove(os.path.join(state_dir, "companies.json"))
    assert bot("--no-notify", env=ACTIONS) == 0
    assert "::notice::seeded companies.json" in capsys.readouterr().out
    assert read_json(os.path.join(state_dir, "companies.json")) == jobwatch.DEFAULT_COMPANIES
    set_companies(state_dir, [])
    assert bot("--no-notify", env=ACTIONS, now=FROZEN_NOW + HOUR) == 0
    assert "::notice::" not in capsys.readouterr().out
    assert read_json(os.path.join(state_dir, "companies.json")) == []


def test_archive_gate_exit_4(bot, state_dir, feed_subset, tmp_path, capsys):
    active_ids = {r["id"] for r in read_json(os.path.join(state_dir, "roles.json")) if r["active"]}
    keep = sorted(active_ids)[:60]  # 80 % of the active roles vanish from the feed
    path = feed_path(tmp_path, [r for r in feed_subset if "simplify:" + r.get("id", "") not in active_ids or "simplify:" + r["id"] in keep])
    before = snapshot(state_dir)
    assert bot("--no-notify", feed=path) == 4
    assert snapshot(state_dir) == before
    assert "active roles would close in one run; force=true if real" in capsys.readouterr().err
    assert bot("--no-notify", "--force", feed=path) == 0
    assert meta(state_dir)["counts"]["closed_this_run"] > 200


def test_archive_gate_ignores_untracked(bot, state_dir):
    set_companies(state_dir, ["cerebras"])  # everything else becomes untracked, not closed
    assert bot("--no-notify") == 0
    m = meta(state_dir)
    assert m["counts"]["closed_this_run"] == 9 and m["counts"]["untracked_this_run"] > 290


def test_untracked_over_half_warns_non_fatal(bot, state_dir, http, capsys):
    set_companies(state_dir, ["cerebras"])
    assert bot(env=dict(CREDS, **ACTIONS)) == 0
    out = capsys.readouterr().out
    assert "::warning::" in out and "roles left your filters this run (config/companies change?)" in out
    assert any("left your filters this run" in w for w in meta(state_dir)["warnings"])
    assert http.telegram_texts()[-1].splitlines()[-1].startswith("Note: ") and "left your filters" in http.telegram_texts()[-1]


def test_untracked_note_sent_alone_when_no_digest(bot, state_dir, http):
    set_companies(state_dir, ["cerebras"])
    write_json(os.path.join(state_dir, "seen.json"), sorted(set(read_json(os.path.join(state_dir, "seen.json"))) | set(SUBSET["new_ids"])))
    assert bot(env=CREDS) == 0
    texts = http.telegram_texts()
    assert len(texts) == 1 and texts[0].startswith("Note: ") and "left your filters this run" in texts[0]
    assert "parse_mode" not in http.calls[0][1] and meta(state_dir)["telegram"]["mode"] == "none"


# ── pruning ─────────────────────────────────────────────────────────────────

def test_prune_exempts_keep_marks_star_note(bot, state_dir):
    status = read_json(os.path.join(state_dir, "status.json"))
    prev = {r["id"]: r for r in read_json(os.path.join(state_dir, "roles.json"))}
    archived_unmarked = [i for i in prev if not prev[i]["active"] and i not in status]
    starred, noted = archived_unmarked[:2]
    status[starred] = {"star": True}
    status[noted] = {"s": "dropped", "note": "worth a second look"}
    write_json(os.path.join(state_dir, "status.json"), status)
    assert bot("--no-notify", now=FROZEN_NOW + 200 * 86400) == 0
    r = rows(state_dir)
    assert starred in r and noted in r
    for i, m in status.items():
        if i in prev and not prev[i]["active"] and m.get("s") in ("applied", "oa", "interview", "offer", "rejected"):
            assert i in r, i


def test_prune_dropped_after_180d(bot, state_dir):
    status = read_json(os.path.join(state_dir, "status.json"))
    prev = {r["id"]: r for r in read_json(os.path.join(state_dir, "roles.json"))}
    gone = [i for i in prev if not prev[i]["active"] and (i not in status or status[i].get("s") == "dropped")
            and i not in GOLDEN["reactivated"]]
    assert gone
    assert bot("--no-notify", now=FROZEN_NOW + 200 * 86400) == 0
    r = rows(state_dir)
    assert not set(gone) & set(r)
    assert all(i in r for i in GOLDEN["closed"])  # closed this run: clock starts now


def test_prune_disabled_when_status_corrupt(bot, state_dir, capsys):
    with open(os.path.join(state_dir, "status.json"), "w") as f:
        f.write("[not, an, object")
    assert bot("--no-notify", now=FROZEN_NOW + 200 * 86400) == 0
    assert len(rows(state_dir)) == 480
    assert "pruning disabled this run" in capsys.readouterr().err


# ── feed gates and fetch ────────────────────────────────────────────────────

def gate_rejects(bot, bare_state_dir, tmp_path, capsys, records, message):
    before = snapshot(bare_state_dir)
    assert bot("--no-notify", feed=feed_path(tmp_path, records), state=bare_state_dir) == 1
    assert message in capsys.readouterr().err and snapshot(bare_state_dir) == before


def test_feed_gate_not_list(bot, bare_state_dir, tmp_path, capsys):
    gate_rejects(bot, bare_state_dir, tmp_path, capsys, {"not": "a list"}, "feed: not a list (schema drift?)")


def test_feed_gate_too_few_records(bot, bare_state_dir, tmp_path, capsys):
    gate_rejects(bot, bare_state_dir, tmp_path, capsys, [{"id": "x"}] * 5, "feed: 5 records (< 1000)")


def test_feed_gate_too_few_active(bot, bare_state_dir, feed_subset, tmp_path, capsys):
    live = [r for r in feed_subset if r.get("active")][:150]
    padded = live + [dict(feed_subset[0], id=f"pad-{i}", active=False) for i in range(1200)]
    live = sum(1 for r in padded if r.get("active") and r.get("is_visible", True))
    assert live < 200
    assert bot("--no-notify", feed=feed_path(tmp_path, padded), state=bare_state_dir) == 1
    assert f"feed: {live} active records (< 200)" in capsys.readouterr().err


def test_feed_gate_missing_keys(bot, state_dir, feed_subset, tmp_path, capsys):
    broken = [{k: v for k, v in r.items() if k != "locations"} for r in feed_subset]
    assert bot("--no-notify", feed=feed_path(tmp_path, broken)) == 1
    assert "feed: records lack key 'locations' (schema drift)" in capsys.readouterr().err


def test_feed_retry_then_success(bot, state_dir, http, clock, feed_subset):
    body = jobwatch.canonical(feed_subset)
    http.feed = [("raise", urllib.error.URLError("reset")), ("http", 503, {}), ("ok", body)]
    assert bot("--no-notify", feed="https://feed.example/listings.json") == 0
    assert [c for c in http.calls if c[0] == "feed"] == [("feed", "https://feed.example/listings.json")] * 3
    assert clock.sleeps == [0, 2, 8] and meta(state_dir)["feed"]["attempts"] == 3


def test_feed_404_no_retry_exit_1(bot, state_dir, http, clock, capsys):
    http.feed = [("http", 404, {})]
    before = snapshot(state_dir)
    assert bot("--no-notify", feed="https://feed.example/listings.json", env=ACTIONS) == 1
    assert len(http.calls) == 1 and clock.sleeps == [0]
    assert "::error::feed: URL gone (HTTP 404) — Simplify moved the file; set feed_url in config.json" in capsys.readouterr().out
    assert snapshot(state_dir) == before


def test_feed_429_on_fourth_attempt_no_indexerror(bot, state_dir, http, clock, capsys):
    http.feed = [("http", 429, {}, {"Retry-After": "7"})] * 4
    assert bot("--no-notify", feed="https://feed.example/listings.json") == 1
    assert len([c for c in http.calls if c[0] == "feed"]) == 4
    assert clock.sleeps == [0, 7, 7, 7]
    assert "feed: fetch failed after 4 attempts: HTTP 429" in capsys.readouterr().err


def test_feed_gate_active_ratio_vs_meta(bot, state_dir, capsys):
    assert bot("--no-notify") == 0  # no meta yet: gate skipped
    m = meta(state_dir)
    m["feed"]["active"] = m["feed"]["active"] * 3
    write_json(os.path.join(state_dir, "meta.json"), m)
    before = snapshot(state_dir)
    assert bot("--no-notify", now=FROZEN_NOW + HOUR) == 1
    assert "active records < 70% of last run's" in capsys.readouterr().err and snapshot(state_dir) == before
    assert bot("--no-notify", "--force", now=FROZEN_NOW + HOUR) == 0
    for feed in ("hand-edited", {"active": "lots"}):  # meta.json is lenient: an unusable previous count skips the gate
        m["feed"] = feed
        write_json(os.path.join(state_dir, "meta.json"), m)
        assert bot("--no-notify", now=FROZEN_NOW + 2 * HOUR) == 0


def test_nothing_written_on_exit_1_2_4(bot, state_dir, tmp_path, capsys):
    before = snapshot(state_dir)
    assert bot("--no-notify", feed=feed_path(tmp_path, {"not": "a list"})) == 1
    assert snapshot(state_dir) == before
    set_companies(state_dir, ["zzz-no-such-company"])
    before = snapshot(state_dir)
    assert bot("--no-notify") == 4
    assert snapshot(state_dir) == before
    with open(os.path.join(state_dir, "seen.json"), "w") as f:
        f.write("[1, 2]")
    before = snapshot(state_dir)
    assert bot("--no-notify") == 2
    assert snapshot(state_dir) == before and "seen.json is corrupt — fix it or delete it to reset" in capsys.readouterr().err


def test_run_writes_nothing_before_plan(bot, state_dir, tmp_path, monkeypatch):
    bad_feed = feed_path(tmp_path, {"not": "a list"})
    roles_json = os.path.join(state_dir, "roles.json")
    good_roles = open(roles_json, "rb").read()

    def boom(*a):
        raise AssertionError("write before the write phase")
    monkeypatch.setattr(jobwatch, "atomic_write", boom)
    assert bot("--no-notify", feed=bad_feed) == 1
    with open(roles_json, "w") as f:
        f.write("{}")
    assert bot("--no-notify") == 2
    with open(roles_json, "wb") as f:
        f.write(good_roles)
    with open(os.path.join(state_dir, "companies.json"), "w") as f:
        f.write('["zzz-no-such-company"]')
    assert bot("--no-notify") == 4
    with open(os.path.join(state_dir, "companies.json"), "w") as f:
        f.write('["cerebras"]')
    with pytest.raises(AssertionError, match="write before the write phase"):
        bot("--no-notify")  # the happy path does reach the write phase, so the patch is live
    assert inspect.getsource(jobwatch.run).count("write_outputs(") == 1


# ── commit noise ────────────────────────────────────────────────────────────

def test_no_op_run_is_byte_identical(bot, state_dir, http):
    assert bot(env=CREDS) == 0
    first = snapshot(state_dir)
    sent = len(http.telegram_texts())
    assert bot(env=CREDS, now=FROZEN_NOW + 3 * HOUR) == 0
    assert snapshot(state_dir) == first
    assert len(http.telegram_texts()) == sent  # nothing new to say


def test_meta_written_on_change(bot, state_dir):
    assert not os.path.exists(os.path.join(state_dir, "meta.json"))
    assert bot("--no-notify") == 0
    m = meta(state_dir)
    assert m["version"] == 2 and m["bot_version"] == "2.0.0" and m["last_run"] == m["last_change"] == FROZEN_NOW
    assert m["last_result"] == "ok" and m["config_source"] == "config.json" and len(m["config_sha"]) == 40
    assert m["counts"]["active"] == SUBSET["active"] and m["counts"]["groups"] == SUBSET["groups"]
    assert m["counts"]["companies"] == SUBSET["companies"] and m["counts"]["new_this_run"] == len(SUBSET["new_ids"])
    assert m["feed"] == {"records": SUBSET["records"], "active": m["feed"]["active"], "fetched_at": FROZEN_NOW, "attempts": 1}
    assert set(m["rejects"]) == {"category", "phd", "title", "region", "sponsorship", "age"}
    assert m["telegram"] == {"mode": "no_notify", "delivered": len(SUBSET["new_ids"]), "failed_chunks": 0, "creds": False}
    assert m["repo"] is None and m["pages_url"] is None and m["warnings"] == []


def test_meta_heartbeat_after_20h(bot, state_dir, capsys):
    assert bot("--no-notify") == 0
    first = snapshot(state_dir)
    assert bot("--dry-run", now=FROZEN_NOW + 21 * HOUR) == 0
    assert would_write(capsys.readouterr().out) == ["meta.json"]  # the preview agrees with the heartbeat rule
    assert bot("--no-notify", now=FROZEN_NOW + 21 * HOUR) == 0
    second = snapshot(state_dir)
    assert {k for k in first if first[k] != second[k]} == {"meta.json"}
    assert meta(state_dir)["last_run"] == FROZEN_NOW + 21 * HOUR and meta(state_dir)["last_change"] == FROZEN_NOW
    assert meta(state_dir)["last_result"] == "ok-no-change"


def test_meta_not_written_on_quiet_run(bot, state_dir):
    assert bot("--no-notify") == 0
    stat = os.stat(os.path.join(state_dir, "meta.json"))
    assert bot("--no-notify", now=FROZEN_NOW + 3 * HOUR) == 0
    assert os.stat(os.path.join(state_dir, "meta.json")).st_mtime_ns == stat.st_mtime_ns


def test_meta_keywords_stats_all_time_names_denied(bot, state_dir):
    assert bot("--no-notify") == 0
    kw = meta(state_dir)["keywords"]
    assert set(kw) == set(jobwatch.keyword_list(read_json(os.path.join(state_dir, "companies.json")), []))
    assert kw["millennium"] == {"active": 0, "all_time": 1, "names": [], "denied": 1}
    assert kw["tiktok"]["active"] > 90 and kw["tiktok"]["names"] == ["TikTok"] and kw["tiktok"]["all_time"] >= kw["tiktok"]["active"]
    assert kw["d matrix"] == {"active": 0, "all_time": 0, "names": [], "denied": 0}
    assert kw["sig"]["names"] == ["Susquehanna International Group (SIG)"]  # first keyword in sorted order wins
    assert "Susquehanna International Group (SIG)" not in kw["susquehanna"]["names"]


def test_roles_deterministic_order(bot, state_dir):
    assert bot("--no-notify") == 0
    listed = read_json(os.path.join(state_dir, "roles.json"))
    assert listed == sorted(listed, key=jobwatch.row_sort_key)
    assert [r["active"] for r in listed] == sorted([r["active"] for r in listed], reverse=True)


def test_explicit_empty_companies_skips_zero_match_gate_and_marks_why_company(bot, state_dir):
    set_companies(state_dir, [])
    assert bot("--no-notify") == 0
    r = rows(state_dir)
    assert {x["why"] for x in r.values() if x["in_feed"]} == {"company"}
    assert meta(state_dir)["counts"]["active"] == 0 and meta(state_dir)["keywords"] == {}


def test_why_company_when_keyword_removed(bot, state_dir):
    drop_keyword(state_dir, "tesla")
    assert bot("--no-notify") == 0
    r = rows(state_dir)
    tesla = [x for x in r.values() if x["company"] == "Tesla" and x["in_feed"]]
    assert tesla and all(x["reason"] == "untracked" and x["why"] == "company" for x in tesla)
    millennium = next(x for x in r.values() if x["company"] == "Millennium Physician Group")
    assert millennium["reason"] == "untracked" and millennium["why"] == "company"  # denied, still live in the feed


def test_known_silent_reactivated_ids_join_seen_without_message(bot, state_dir, http):
    before = seen(state_dir)
    assert not set(SUBSET["known_silent"]) & before
    assert bot(env=CREDS) == 0
    assert set(SUBSET["known_silent"]) <= seen(state_dir) and len(SUBSET["known_silent"]) == 5
    for rid in SUBSET["known_silent"]:
        assert rows(state_dir)[rid]["active"] is True
        assert all(rows(state_dir)[rid]["url"] not in t for t in http.telegram_texts())
    assert meta(state_dir)["counts"]["silent_known_this_run"] == 5


def test_marked_role_never_announced(bot, state_dir, http):
    status = read_json(os.path.join(state_dir, "status.json"))
    assert status[VIRTU] == {"s": "dropped"} and VIRTU not in seen(state_dir)
    assert bot(env=CREDS) == 0
    assert VIRTU in seen(state_dir) and all(rows(state_dir)[VIRTU]["url"] not in t for t in http.telegram_texts())
    write_json(os.path.join(state_dir, "status.json"), {VIRTU: {"d": FROZEN_NOW}})  # a tombstone is still "shown before"
    write_json(os.path.join(state_dir, "seen.json"), sorted(seen(state_dir) - {VIRTU}))
    http.calls.clear()
    assert bot(env=CREDS, now=FROZEN_NOW + HOUR) == 0
    assert VIRTU in seen(state_dir) and http.telegram_texts() == []


def test_failed_chunk_active_unmarked_id_is_reannounced(bot, state_dir, http):
    multi_chunk(state_dir)
    http.telegram = ["ok", ("http", 502, {}), ("http", 502, {}), ("http", 502, {})]
    assert bot(env=CREDS) == 0
    missed = set(SUBSET["new_ids"]) - seen(state_dir)
    assert missed and all(rows(state_dir)[rid]["active"] for rid in missed)
    http.calls.clear()
    assert bot(env=CREDS, now=FROZEN_NOW + 2 * HOUR) == 0
    texts = http.telegram_texts()
    assert len(texts) == 1 and all(rows(state_dir)[rid]["url"] in texts[0] for rid in missed)
    assert missed <= seen(state_dir) and f"<b>{len(missed)} new roles</b>" in texts[0]


def test_feed_differing_only_in_date_updated_is_noop(bot, state_dir, feed_subset, tmp_path):
    assert bot("--no-notify") == 0
    first = snapshot(state_dir)
    bumped = [dict(r, date_updated=FROZEN_NOW + HOUR) if "date_updated" in r else r for r in feed_subset]
    assert bot("--no-notify", feed=feed_path(tmp_path, bumped), now=FROZEN_NOW + 3 * HOUR) == 0
    assert snapshot(state_dir) == first


def test_telegram_deadline_marks_rest_failed_and_write_phase_runs(bot, state_dir, http, clock, capsys):
    multi_chunk(state_dir)
    original = http.urlopen

    def slow(req, timeout=None):
        clock.t += 500  # the first send outlives the 180 s delivery budget
        return original(req, timeout)
    http.urlopen = slow
    assert bot(env=dict(CREDS, **ACTIONS)) == 0
    out = capsys.readouterr().out
    assert len(http.telegram_texts()) == 1
    assert "failed: delivery deadline reached — " in out and "::warning::telegram chunk 2/" in out
    assert os.path.exists(os.path.join(state_dir, "meta.json")) and meta(state_dir)["telegram"]["mode"] == "partial"


def test_quiet_hours_holds_delivery_and_seen(bot, state_dir, http, capsys):
    hour = jobwatch.datetime.fromtimestamp(FROZEN_NOW, jobwatch.ZoneInfo("UTC")).hour
    set_config(state_dir, **telegram(quiet_hours={"start": hour, "end": (hour + 2) % 24, "tz": "UTC"}))
    assert bot(env=CREDS) == 0
    assert http.calls == [] and not set(SUBSET["new_ids"]) & seen(state_dir)
    err = capsys.readouterr().err
    assert f"[info] quiet hours ({hour}–{(hour + 2) % 24} UTC): " in err and f"chunk(s) held — sent by the first run after {(hour + 2) % 24}:00" in err
    assert meta(state_dir)["telegram"]["mode"] == "quiet"
    assert bot(env=CREDS, now=FROZEN_NOW + 3 * HOUR) == 0
    assert http.telegram_texts() and set(SUBSET["new_ids"]) <= seen(state_dir)


def test_meta_written_when_config_sha_or_keywords_change(bot, state_dir):
    assert bot("--no-notify") == 0
    first = snapshot(state_dir)
    set_config(state_dir, readme={"collapse_over": 21})
    assert bot("--no-notify", now=FROZEN_NOW + HOUR) == 0
    second = snapshot(state_dir)
    assert {k for k in first if first[k] != second[k]} == {"config.json", "meta.json"}
    assert meta(state_dir)["config_sha"] == jobwatch.blob_sha(second["config.json"])
    set_companies(state_dir, read_json(os.path.join(state_dir, "companies.json")) + ["zzz-no-such-company"])
    assert bot("--no-notify", now=FROZEN_NOW + 2 * HOUR) == 0
    third = snapshot(state_dir)
    assert {k for k in second if second[k] != third[k]} == {"companies.json", "meta.json"}
    assert meta(state_dir)["keywords"]["zzz no such company"] == {"active": 0, "all_time": 0, "names": [], "denied": 0}


def test_newly_tracked_header_skipped_without_meta_prev_keywords(bot, state_dir, http, capsys):
    companies = read_json(os.path.join(state_dir, "companies.json"))
    set_companies(state_dir, companies + ["oclc"])
    assert bot("--dry-run", env=CREDS) == 0
    assert "newly tracked" not in capsys.readouterr().out  # first v2 run: no meta_prev.keywords
    set_companies(state_dir, companies)
    assert bot(env=CREDS) == 0
    set_companies(state_dir, companies + ["oclc"])
    http.calls.clear()
    assert bot(env=CREDS, now=FROZEN_NOW + 2 * HOUR) == 0
    text = http.telegram_texts()[0]
    assert "· incl. newly tracked: oclc (1)" in text.splitlines()[0] and "<b>OCLC</b> (1)" in text
    assert meta(state_dir)["keywords"]["oclc"]["active"] == 1


def test_ops_alert_on_exit_2_and_4(state_dir, http, clock, feed_file, monkeypatch):
    real = jobwatch.Runtime
    monkeypatch.setattr(jobwatch, "Runtime", lambda: real(now=FROZEN_NOW, env=dict(CREDS, GITHUB_RUN_URL="https://run/1"),
                                                          urlopen=http.urlopen, sleep=clock.sleep, monotonic=clock.monotonic))
    assert jobwatch.main(["--feed", os.path.join(state_dir, "missing.json"), "--state-dir", state_dir]) == 1
    assert http.calls == []  # exit 1 sends nothing from Python
    set_companies(state_dir, ["zzz-no-such-company"])
    assert jobwatch.main(["--feed", feed_file, "--state-dir", state_dir]) == 4
    assert http.telegram_texts() == ["jobwatch: 0 matches while 308 roles were active and 1 keywords are configured — pass --force / "
                                     "force=true if intended. Run: https://run/1"]
    with open(os.path.join(state_dir, "roles.json"), "w") as f:
        f.write("nope")
    assert jobwatch.main(["--feed", feed_file, "--state-dir", state_dir]) == 2
    assert http.telegram_texts()[-1].startswith("jobwatch: roles.json is not valid JSON")
    http.calls.clear()  # inside Actions the workflow's notify step is the only sender (one alert per failure, not two)
    monkeypatch.setattr(jobwatch, "Runtime", lambda: real(now=FROZEN_NOW, env=dict(CREDS, GITHUB_ACTIONS="true", GITHUB_RUN_URL="https://run/1"),
                                                          urlopen=http.urlopen, sleep=clock.sleep, monotonic=clock.monotonic))
    assert jobwatch.main(["--feed", feed_file, "--state-dir", state_dir]) == 2
    assert http.calls == []


def test_step_summary_and_verbose(bot, state_dir, tmp_path, capsys):
    summary = tmp_path / "summary.md"
    assert bot("--no-notify", "--verbose", env={"GITHUB_STEP_SUMMARY": str(summary)}) == 0
    lines = summary.read_text().splitlines()
    assert len(lines) == 5 and lines[0].startswith("**jobwatch** exit 0 ·") and "files changed: README.md, meta.json, roles.json, seen.json" in lines[4]
    out = capsys.readouterr().out
    assert "[verbose] phd " in out and "[verbose] MATCH NEW" in out and "[verbose] MATCH seen" in out and "[verbose] MATCH silent" in out
