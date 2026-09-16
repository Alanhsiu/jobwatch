import os

import pytest

import jobwatch
from conftest import FROZEN_NOW, REAL, cfg_with, read_json

CFG = cfg_with()
ROLES = {r["id"]: r for r in read_json(os.path.join(REAL, "roles.json"))}
FEED_ROLES = {"simplify:" + r["id"]: jobwatch.normalize_record(r)
              for r in read_json(os.path.join(REAL, "..", "listings_subset.json")) if r.get("active")}
XAI = "simplify:036f95f0-b954-4120-bd02-980666b57a4d"
NVIDIA = "simplify:fb8993b6-84c3-4607-801f-ed29b702f2f8"
TESLA = "simplify:bf15bc13-29b7-40a4-83f5-9a809a1d744e"
TIKTOK_D = ["simplify:4d762004", "simplify:a4647510", "simplify:51d49505"]


def feed_role(feed_subset, rid):
    rec = next(r for r in feed_subset if "simplify:" + r["id"] == rid)
    role = jobwatch.normalize_record(rec)
    assert jobwatch.classify(role, CFG, ROLES, FROZEN_NOW) is None
    return role


def model(prev, matched, live, why=None, marks=None, now=FROZEN_NOW, unreliable=False):
    """`live` may be a dict of normalised roles or just the ids (records then default to the fixture feed)."""
    if not isinstance(live, dict):
        live = {rid: FEED_ROLES[rid] for rid in live}
    return jobwatch.apply_roles_model(prev, matched, live, why or {}, marks or {}, CFG, now, unreliable)


def test_legacy_archived_row_migrates():
    rows = model({XAI: ROLES[XAI]}, {}, set())
    assert rows == [{
        "id": XAI, "company": "xAI", "title": "Member of Technical Staff", "location": "Palo Alto, CA",
        "url": "https://job-boards.greenhouse.io/xai/jobs/5173147007", "category": "SWE", "posted": "2026-07-08",
        "date_posted": 1783549489, "active": False, "first_seen": 1784014543.6740808, "last_seen": 1785947304.4858618,
        "group": "xai|member of technical staff", "in_feed": False, "reason": "closed", "closed_at": 1785947304,
    }]


def test_legacy_archived_live_row_reactivates(feed_subset):
    role = feed_role(feed_subset, NVIDIA)
    (row,) = model({NVIDIA: ROLES[NVIDIA]}, {NVIDIA: role}, {NVIDIA})
    assert row == {
        "id": NVIDIA, "company": "NVIDIA", "title": "Software Engineer New Grad - Hardware Tools and Methodology",
        "location": "Santa Clara, CA",
        "url": "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Software-Engineer--Hardware-Tools-and-Methodology---New-College-Grad-2026_JR2018659",
        "category": "SWE", "posted": "2026-06-03", "date_posted": 1780524471, "active": True,
        "first_seen": 1784678336.2126446, "last_seen": 1786980001.7232995, "locations": ["Santa Clara, CA"], "region": "US",
        "degrees": ["Master's", "PhD"], "sponsorship": "Other",
        "group": "nvidia|software engineer new grad hardware tools and methodology", "in_feed": True, "reason": None,
    }


def test_untracked_row_gets_why(feed_subset):
    rec = next(r for r in feed_subset if "simplify:" + r["id"] == TESLA)
    role = jobwatch.normalize_record(rec)
    assert jobwatch.classify(role, CFG, ROLES, FROZEN_NOW) == "title"
    (row,) = model({TESLA: ROLES[TESLA]}, {}, {TESLA}, why={TESLA: "title"})
    assert row["active"] is False and row["in_feed"] is True
    assert row["reason"] == "untracked" and row["why"] == "title"
    assert row["closed_at"] == FROZEN_NOW and row["last_seen"] == FROZEN_NOW
    assert row["group"] == "tesla|data collection operator optimus" and row["posted"] == "2026-09-03"
    assert row["first_seen"] == ROLES[TESLA]["first_seen"]  # v1 float kept verbatim
    assert (row["locations"], row["region"], row["degrees"], row["sponsorship"]) == (["Austin, TX"], "US", [], "Other")


def test_phd_sibling_untracked_in_group(feed_subset):
    ids = [i for i in ROLES if any(i.startswith(p) for p in TIKTOK_D)]
    assert len(ids) == 3
    recs = {"simplify:" + r["id"]: jobwatch.normalize_record(r) for r in feed_subset if "simplify:" + r["id"] in ids}
    matched, why = {}, {}
    for rid, role in recs.items():
        reason = jobwatch.classify(role, CFG, ROLES, FROZEN_NOW)
        (why.__setitem__(rid, reason) if reason else matched.__setitem__(rid, role))
    rows = {r["id"]: r for r in model({i: ROLES[i] for i in ids}, matched, set(ids), why)}
    assert {r["group"] for r in rows.values()} == {"tiktok|machine learning engineer graduate e commerce governance"}
    phd = [r for r in rows.values() if r["degrees"] == ["PhD"]]
    active = [r for r in rows.values() if r["active"]]
    assert len(active) == 2 and len(phd) == 1 and not phd[0]["active"]
    assert phd[0]["reason"] == "untracked" and phd[0]["why"] == "phd" and phd[0]["in_feed"] is True


def test_closed_at_written_once():
    (row,) = model({TESLA: ROLES[TESLA]}, {}, set())
    assert row["closed_at"] == FROZEN_NOW and row["reason"] == "closed"
    (again,) = model({TESLA: row}, {}, set(), now=FROZEN_NOW + 5 * 86400)
    assert again["closed_at"] == FROZEN_NOW and again["last_seen"] == FROZEN_NOW
    (back_in_feed,) = model({TESLA: again}, {}, {TESLA}, why={TESLA: "phd"}, now=FROZEN_NOW + 6 * 86400)
    assert back_in_feed["closed_at"] == FROZEN_NOW and back_in_feed["reason"] == "untracked" and back_in_feed["why"] == "phd"


def test_last_seen_frozen_while_active(feed_subset):
    rid = next(i for i in ROLES if i.startswith("simplify:1f3302b8"))  # TikTok "... - Lead Ads", applied
    role = feed_role(feed_subset, rid)
    (row,) = model({rid: ROLES[rid]}, {rid: role}, {rid}, now=FROZEN_NOW + 30 * 86400)
    assert row["last_seen"] == ROLES[rid]["last_seen"]
    assert row["first_seen"] == ROLES[rid]["first_seen"]
    assert "closed_at" not in row


def test_reactivation_clears_closed_at_and_why(feed_subset):
    role = feed_role(feed_subset, NVIDIA)
    archived = dict(ROLES[NVIDIA], active=False, closed_at=1786980001, reason="untracked", why="phd", in_feed=True)
    (row,) = model({NVIDIA: archived}, {NVIDIA: role}, {NVIDIA})
    assert row["active"] is True and row["reason"] is None and row["in_feed"] is True
    assert "closed_at" not in row and "why" not in row
    assert row["last_seen"] == ROLES[NVIDIA]["last_seen"]


def test_unknown_keys_pass_through(feed_subset):
    role = feed_role(feed_subset, NVIDIA)
    (row,) = model({NVIDIA: dict(ROLES[NVIDIA], custom_note="keep me")}, {NVIDIA: role}, {NVIDIA})
    assert row["custom_note"] == "keep me"
    (row,) = model({XAI: dict(ROLES[XAI], custom_note="keep me too")}, {}, set())
    assert row["custom_note"] == "keep me too"


def test_duplicate_ids_exit_2(state_dir):
    roles = read_json(os.path.join(state_dir, "roles.json"))
    roles.append(dict(roles[0]))
    jobwatch.atomic_write(os.path.join(state_dir, "roles.json"), jobwatch.canonical(roles))
    with pytest.raises(jobwatch.Abort) as e:
        jobwatch.load_state(jobwatch.Paths(state_dir, os.path.join(state_dir, "config.json")))
    assert e.value.code == 2 and "duplicate id" in e.value.message


def test_posted_is_iso_date(feed_subset):
    rows = model(dict(ROLES), {}, set())
    assert all(jobwatch.re.fullmatch(r"\d{4}-\d{2}-\d{2}", r["posted"]) for r in rows)
    assert jobwatch.iso_date(1783549489) == "2026-07-08"
    assert jobwatch.iso_date(None) == jobwatch.iso_date(0) == jobwatch.iso_date(10**17) == jobwatch.iso_date("soon") == ""


def test_new_row_shape(feed_subset):
    role = feed_role(feed_subset, NVIDIA)
    (row,) = model({}, {NVIDIA: role}, {NVIDIA})
    assert row["first_seen"] == FROZEN_NOW and "last_seen" not in row and isinstance(row["first_seen"], int)


def test_prune_rules():
    old = dict(ROLES[XAI])  # last_seen 2026-08-01 -> closed_at derived from it
    assert model({XAI: old}, {}, set(), now=FROZEN_NOW + 200 * 86400) == []
    assert len(model({XAI: old}, {}, set(), marks={XAI: {"s": "applied"}}, now=FROZEN_NOW + 200 * 86400)) == 1
    assert len(model({XAI: old}, {}, set(), marks={XAI: {"star": True}}, now=FROZEN_NOW + 200 * 86400)) == 1
    assert len(model({XAI: old}, {}, set(), marks={XAI: {"note": "x"}}, now=FROZEN_NOW + 200 * 86400)) == 1
    assert model({XAI: old}, {}, set(), marks={XAI: {"s": "dropped"}}, now=FROZEN_NOW + 200 * 86400) == []
    assert model({XAI: old}, {}, set(), marks={XAI: {"d": 1}}, now=FROZEN_NOW + 200 * 86400) == []
    assert len(model({XAI: old}, {}, set(), now=FROZEN_NOW + 200 * 86400, unreliable=True)) == 1


def test_deterministic_order(feed_subset):
    rows = model(dict(ROLES), {NVIDIA: feed_role(feed_subset, NVIDIA)}, {NVIDIA})
    assert rows == sorted(rows, key=jobwatch.row_sort_key)
    assert rows[0]["active"] is True and rows[-1]["active"] is False


@pytest.mark.parametrize("key, value", [("date_posted", "1788453040"), ("first_seen", True), ("closed_at", [1])])
def test_roles_row_bad_date_posted_exits_2(state_dir, key, value):
    roles = read_json(os.path.join(state_dir, "roles.json"))
    roles[3][key] = value
    jobwatch.atomic_write(os.path.join(state_dir, "roles.json"), jobwatch.canonical(roles))
    with pytest.raises(jobwatch.Abort) as e:
        jobwatch.load_state(jobwatch.Paths(state_dir, os.path.join(state_dir, "config.json")))
    assert e.value.code == 2 and roles[3]["id"] in e.value.message and key in e.value.message
