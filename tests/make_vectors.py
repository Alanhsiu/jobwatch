#!/usr/bin/env python3
"""Spec-exact fixture generator for the jobwatch test suites (Python and JS).

    python3 tests/make_vectors.py                       # rewrite fixtures/vectors.json + fixtures/expected.json
    python3 tests/make_vectors.py --feed listings.json --state-dir tests/fixtures/real
                                                        # ...and print the §6.9 numbers measured on a full feed snapshot
    python3 tests/make_vectors.py --build-subset --feed listings.json
                                                        # rebuild fixtures/listings_subset.json from a full snapshot

vectors.json holds the tables shared with tests/js (norm, group_key, region, iso_date, parse_marks); every
region string is checked against the §6.6 class it must fall in, so generation fails if the code drifts
from the spec. expected.json enumerates what the golden test must see (the classifier's flips on the real
state files) and is derived from listings_subset.json, so it is reproducible without the full snapshot.
"""

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import jobwatch  # noqa: E402

FIXTURES = os.path.join(HERE, "fixtures")
REAL = os.path.join(FIXTURES, "real")
SUBSET = os.path.join(FIXTURES, "listings_subset.json")
VECTORS = os.path.join(FIXTURES, "vectors.json")
EXPECTED = os.path.join(FIXTURES, "expected.json")

# Frozen clock for every fixture-driven test: the state files were captured on 2026-09-04 ~01:00 UTC;
# one day later nothing in roles.json ages out or reaches the 180-day prune horizon.
FROZEN_NOW = 1788586400  # 2026-09-05 05:33:20 UTC

NORM_INPUTS = [
    "d-Matrix", "Susquehanna International Group (SIG)", "D. E. Shaw & Co", "Snap Inc.", "Snap-on",
    "Millennium Physician Group", "Millennium Management", "Upscale AI", "Scale AI", "Cruise Planners",
    "Hudson River Trading (HRT)", "Character.AI", "X Development LLC", "Akuna Capital University",
    "Bloomberg Industry Group", "Optiver US LLC", "  Multiple   Spaces  ", "", "TikTok", "ByteDance",
    "Point72", "Jane Street", "Two Sigma", "Ünïcode Café", "Software Engineer (2026)",
    "Machine Learning Engineer – New Grad", "Quantitative Researcher - Ph.D", "C++/CUDA Kernel Engineer",
    "Data Scientist, Core Data", "Software Engineer New Grad - Hardware Tools & Methodology",
]

GROUP_INPUTS = [
    ["TikTok", "Machine Learning Engineer Graduate - E-Commerce Governance"],
    ["TikTok", "Software Engineer New Grad (2026)"],
    ["TikTok", "Software Engineer New Grad"],
    ["ByteDance", "Backend Development Engineer Graduate (Backend)"],
    ["ByteDance", "Backend Development Engineer Graduate (Frontend)"],
    ["NVIDIA", "Applied Machine Learning Engineer – New College Grad 2026 - Circuit Design"],
    ["NVIDIA", "Software Engineer New Grad - Hardware Tools and Methodology"],
    ["xAI", "Member of Technical Staff"],
    ["Susquehanna International Group (SIG)", "Quantitative Systematic Trader (QST)"],
    ["D. E. Shaw & Co", "Software Developer (Entry Level)"],
    ["Citadel Securities", "Quantitative Researcher – PhD Graduate - Europe"],
    ["Apple", "Cellular Layer-1 Control Software Development Engineer - Wireless Technologies & Ecosystems"],
    ["Figma", "Data Scientist, Core Data"],
    ["d-Matrix", "Kernel Engineer (New Grad) (2026)"],
    ["Tesla", "Data Collection Operator - Optimus"],
    ["Cerebras", "Software Engineer New Grad"],
    ["Two Sigma", "AI Research Scientist - Campus Full-Time"],
    ["Anthropic", "Research Scientist - Takeoff Intel"],
    ["Virtu Financial", "Software Engineer - Desktop Frontend Developer - C#/Winforms"],
    ["", ""],
]

# §6.6 pinned table — exact strings, commas included; † (synthetic) strings do not occur in the live feed.
REGION_TABLE = {
    "US": ["SF", "South SF", "California", "Washington", "Washington, D.C.", "Washington DC", "Remote",
           "Remote in USA", "Remote in US", "Remote in USA (FL)", "Remote in the US", "NYC", "LA",
           "United States", "Georgia", "Indianapolis, IN", "Austin, TX", "Ontario, CA", "Canada, United States",
           "Philadelphia, PA", "New York, NY", "Cambridge, MA", "Londonderry, NH", "Vancouver, WA", "Dublin, OH",
           "Dublin, CA", "Melbourne, FL", "Paris, TX", "London, KY"],
    "other": ["Remote in Canada", "Remote in UK", "Remote in Germany", "La Ronge, SK, Canada",
              "Toronto, ON, Canada", "London, UK", "London", "Farringdon, London, UK", "Beaconsfield, UK",
              "Cambridge, UK", "Vancouver, BC, Canada", "Dublin, Ireland", "Paris, France",
              "Hyderabad, Telangana, India", "Canada", "Munich, Germany",
              "Milan, Metropolitan City of Milan, Italy", "Europe", "Bangalore, IN", "Berlin, DE", ""],
    "TW": ["Taipei, Taiwan", "Hsinchu", "New Taipei City, Taiwan"],
}
REGION_SYNTHETIC = {"Washington, D.C.", "Washington DC", "Remote in the US", "Canada, United States", "Paris, TX",
                    "London, KY", "Bangalore, IN", "Berlin, DE", "Taipei, Taiwan", "Hsinchu",
                    "New Taipei City, Taiwan", ""}

ISO_INPUTS = [0, 1, 86399, 86400, 951782400, 1704067200, 1783549489, 1788453040, 1788586400, 4102444800]

PARSE_MARKS_CASES = [
    ("legacy string stage", "applied"),
    ("legacy string 'todo' is never stored", "todo"),
    ("plain mark", {"s": "applied"}),
    ("mark with star", {"s": "applied", "star": True}),
    ("unknown stage dropped, star kept", {"s": "wat", "star": True}),
    ("junk keys ignored", {"s": "oa", "t": 1788000000, "foo": "bar", "_v": 3}),
    ("tombstone", {"d": 1788000000}),
    ("history with null t", {"s": "interview", "t": 1787112464,
                             "h": [{"s": "applied", "t": None}, {"s": "interview", "t": 1787112464}]}),
    ("none of s/star/note/d", {"foo": 1, "star": False}),
    ("note trimmed", {"note": "  call back Monday  "}),
    ("empty note and false star dropped", {"star": False, "note": "   "}),
    ("invalid history items dropped", {"s": "applied", "h": [{"s": "bogus", "t": 1}, {"s": "seen", "t": 2}, "x"]}),
]


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(path, obj):
    jobwatch.atomic_write(path, jobwatch.canonical(obj))


def make_vectors():
    region = []
    for expected, strings in REGION_TABLE.items():
        for s in strings:
            got = jobwatch.loc_region(s)
            assert got == expected, f"loc_region({s!r}) = {got}, spec says {expected}"
            region.append({"in": s, "out": expected, "synthetic": s in REGION_SYNTHETIC})
    parse_marks = []
    for i, (label, entry) in enumerate(PARSE_MARKS_CASES):
        rid = f"simplify:case-{i:02d}"
        parse_marks.append({"label": label, "id": rid, "in": entry, "out": jobwatch.parse_marks({rid: entry}).get(rid)})
    return {
        "norm": [{"in": s, "out": jobwatch.norm(s)} for s in NORM_INPUTS],
        "group_key": [{"company": c, "title": t, "out": jobwatch.group_key(c, t)} for c, t in GROUP_INPUTS],
        "region": region,
        "iso_date": [{"in": ts, "out": jobwatch.iso_date(ts)} for ts in ISO_INPUTS],
        "parse_marks": parse_marks,
    }


def run_plan(feed_path, state_dir, now, feed_filter=None, small=False):
    """Phases A–C of the bot on a feed file with a frozen clock (defaults; size gates relaxed when `small`)."""
    paths = jobwatch.Paths(state_dir, os.path.join(state_dir, "config.json"))
    state = jobwatch.load_state(paths)
    raw = load(feed_path)
    if feed_filter:
        raw = [r for r in raw if feed_filter(r)]
    cfg = state.cfg
    if small:  # a fixture feed is small by construction; the size gates are not what is under test
        cfg.data["feed"] = dict(cfg.feed, min_records=0, min_active=0)
    rt = jobwatch.Runtime(now=now, env={})
    live = jobwatch.gate_feed(raw, cfg, state.meta, force=False)
    info = {"records": len(raw), "active": len(live), "fetched_at": int(rt.now), "attempts": 1}
    return state, jobwatch.build_plan(state, live, info, cfg, now, force=False)


def make_expected(subset_path):
    """Enumerate the classifier's flips on the real state files (golden test) and the subset totals."""
    roles = load(os.path.join(REAL, "roles.json"))
    known = {r["id"] for r in roles}
    state, golden = run_plan(subset_path, REAL, FROZEN_NOW, lambda r: "simplify:" + r.get("id", "") in known, small=True)
    _, subset = run_plan(subset_path, REAL, FROZEN_NOW, small=True)
    prev = {r["id"]: r for r in roles}
    rows = {r["id"]: r for r in golden.rows}
    marks = state.marks
    keep = sorted(i for i in prev if jobwatch.has_keep_mark(marks, i, state.cfg.keep_marks))
    return {
        "frozen_now": FROZEN_NOW,
        "golden": {
            "roles": len(roles),
            "active": sum(1 for r in golden.rows if r.get("active")),
            "untracked": {i: rows[i]["why"] for i in sorted(golden.untracked_now)},
            "closed": sorted(golden.newly_closed),
            "reactivated": sorted(i for i in golden.matched if i in prev and not prev[i].get("active")),
            "known_silent": sorted(golden.known_silent),
            "new_ids": sorted(golden.new_ids),
            "keep_marked": keep,
            "keywords": len(golden.keywords),
        },
        "subset": {
            "records": len(load(subset_path)),
            "active": sum(1 for r in subset.rows if r.get("active")),
            "companies": len({r["company"] for r in subset.rows if r.get("active")}),
            "groups": len({r["group"] for r in subset.rows if r.get("active")}),
            "new_ids": sorted(subset.new_ids),
            "known_silent": sorted(subset.known_silent),
            "untracked": len(subset.untracked_now),
            "closed": len(subset.newly_closed),
            "rejects": dict(sorted(subset.rejects.items())),
        },
    }


# ── subset construction ──────────────────────────────────────────────────────

# (label, predicate on a raw feed record) — first record by id wins; all-record cases may be inactive.
SUBSET_CASES = [
    ("SF-only location", lambda r: r["locations"] == ["SF"]),
    ("bare state name California", lambda r: r["locations"] == ["California"]),
    ("bare state name Georgia", lambda r: r["locations"] == ["Georgia"]),
    ("bare state name Washington", lambda r: r["locations"] == ["Washington"]),
    ("Remote in Canada", lambda r: "Remote in Canada" in r["locations"]),
    ("Remote in UK", lambda r: "Remote in UK" in r["locations"]),
    ("Remote in USA (FL)", lambda r: "Remote in USA (FL)" in r["locations"]),
    ("La Ronge, SK, Canada", lambda r: "La Ronge, SK, Canada" in r["locations"]),
    ("Ontario, CA", lambda r: "Ontario, CA" in r["locations"]),
    ("Vancouver, WA", lambda r: "Vancouver, WA" in r["locations"]),
    ("Dublin, OH", lambda r: "Dublin, OH" in r["locations"]),
    ("Dublin, CA", lambda r: "Dublin, CA" in r["locations"]),
    ("Melbourne, FL", lambda r: "Melbourne, FL" in r["locations"]),
    ("Indianapolis, IN + Hyderabad", lambda r: "Indianapolis, IN" in r["locations"] and any("India" in x for x in r["locations"])),
    ("Cerebras Canada+US", lambda r: r["company_name"] == "Cerebras" and r["locations"] == ["Canada", "United States"]),
    ("Cerebras Toronto+Sunnyvale", lambda r: r["company_name"] == "Cerebras" and "Toronto, ON, Canada" in r["locations"]),
    ("empty degrees + Research Scientist", lambda r: r["degrees"] == [] and "Research Scientist" in r["title"] and r["active"]),
    ("Member of Technical Staff (xAI, inactive)", lambda r: r["company_name"] == "xAI" and r["title"] == "Member of Technical Staff"),
    ("Lead Ads", lambda r: "Lead Ads" in r["title"] and r["company_name"] == "TikTok"),
    ("Software Engineer 2 / Senior", lambda r: r["title"].startswith("Software Engineer 2 / Senior")),
    ("Senior ... New Grad (waived seniority)", lambda r: "Senior" in r["title"] and "New Grad" in r["title"]),
    ("Tesla operator", lambda r: r["company_name"] == "Tesla" and "Operator" in r["title"]),
    ("Tesla afternoon shift", lambda r: r["company_name"] == "Tesla" and "Shift" in r["title"]),
    ("Tesla trainee", lambda r: r["company_name"] == "Tesla" and "Trainee" in r["title"]),
    ("Tesla labeler", lambda r: r["company_name"] == "Tesla" and "Labeler" in r["title"]),
    ("Figure Data Creator", lambda r: r["company_name"] == "Figure" and r["title"] == "Data Creator"),
    ("Humanoid Robot Pilot", lambda r: r["title"] == "Humanoid Robot Pilot"),
    ("Zoox Student Worker", lambda r: "Student Worker" in r["title"] and r["company_name"] == "Zoox"),
    ("Upscale AI (deny)", lambda r: r["company_name"] == "Upscale AI"),
    ("Millennium Physician Group (deny)", lambda r: r["company_name"] == "Millennium Physician Group"),
    ("Snap-on (deny, inactive)", lambda r: r["company_name"] == "Snap-on"),
    ("Cruise Planners (deny, inactive)", lambda r: r["company_name"] == "Cruise Planners"),
    ("Bloomberg Industry Group (deliberate match)", lambda r: r["company_name"] == "Bloomberg Industry Group"),
    ("Akuna Capital University", lambda r: r["company_name"] == "Akuna Capital University"),
    ("Susquehanna (SIG)", lambda r: r["company_name"].startswith("Susquehanna")),
    ("GPU Verification (HW exclude)", lambda r: r["title"] == "GPU Verification Engineer New Grad"),
    ("NVIDIA VLSI physical design (known HW miss)", lambda r: "VLSI Physical Design" in r["title"] and r["company_name"] == "NVIDIA"),
    ("Waymo PhD in title with MS", lambda r: r["company_name"] == "Waymo" and r["title"].endswith("PhD")),
    ("Old Mission Ph.D title", lambda r: r["company_name"] == "Old Mission" and "Ph.D" in r["title"]),
    ("Citadel Quantitative AI Technical Staff", lambda r: r["title"] == "Quantitative AI Technical Staff"),
    ("Citadel QR Analyst University Graduate", lambda r: r["title"] == "Quantitative Research Analyst University Graduate"),
    ("en-dash title (NVIDIA)", lambda r: r["company_name"] == "NVIDIA" and "–" in r["title"] and r["active"]),
    ("real sponsorship reject (untracked company)", lambda r: r["sponsorship"] == "U.S. Citizenship is Required" and r["active"]),
    ("Amazon Cambridge UK", lambda r: r["company_name"] == "Amazon" and "Cambridge, UK" in r["locations"]),
    ("Farringdon, London, UK", lambda r: "Farringdon, London, UK" in r["locations"]),
    ("Milan, Italy", lambda r: any(x.startswith("Milan,") for x in r["locations"])),
    ("Europe", lambda r: "Europe" in r["locations"]),
    ("bare London", lambda r: "London" in r["locations"]),
]


def synthetic(base, suffix, **changes):
    """A guard record for a † string: a copy of a real record with a new id and the changed fields."""
    rec = dict(base, id=f"synthetic-{suffix}", source="synthetic", **changes)
    rec["_synthetic"] = "guard record for a string the live feed does not contain (spec §6.6/§12.1)"
    return rec


def build_subset(full_feed_path):
    feed = sorted(load(full_feed_path), key=lambda r: r["id"])
    roles = load(os.path.join(REAL, "roles.json"))
    known = {r["id"] for r in roles}
    cfg = jobwatch.Config(jobwatch.copy.deepcopy(jobwatch.DEFAULT_CONFIG))
    keywords = jobwatch.keyword_list(load(os.path.join(REAL, "companies.json")), [])
    chosen = {}
    for rec in feed:
        live = rec.get("active") and rec.get("is_visible", True)
        rid = "simplify:" + rec["id"]
        if live and rid in known:
            chosen[rec["id"]] = rec  # every live record of a tracked role (the golden test's feed)
            continue
        if live and jobwatch.match_company(rec["company_name"], keywords, cfg.deny):
            role = jobwatch.normalize_record(rec)
            if jobwatch.classify(role, cfg, known, FROZEN_NOW) is None:
                chosen[rec["id"]] = rec  # brand-new v2 matches (the Telegram digest)
    aged = [r for r in feed if r.get("active") and "simplify:" + r["id"] not in known
            and jobwatch.match_company(r["company_name"], keywords, cfg.deny)
            and FROZEN_NOW - r["date_posted"] > cfg.max_age_days * 86400]
    if aged:
        chosen[aged[0]["id"]] = aged[0]  # aged-out unknown id at a tracked company
    for label, pred in SUBSET_CASES:
        hits = [r for r in feed if pred(r)]
        if not hits:
            print(f"[warn] subset case has no record in this feed: {label}", file=sys.stderr)
            continue
        chosen[hits[0]["id"]] = hits[0]
    base = next(r for r in feed if r["company_name"] == "Cerebras" and r["active"] and r["locations"] == ["Canada", "United States"])
    for rec in (
        synthetic(base, "canada-united-states", locations=["Canada, United States"]),
        synthetic(base, "bangalore-in", title="Kernel Engineer New Grad - Bangalore", locations=["Bangalore, IN"]),
        synthetic(base, "berlin-de", title="Kernel Engineer New Grad - Berlin", locations=["Berlin, DE"]),
        synthetic(base, "sponsorship-reject", title="Kernel Engineer New Grad - Cleared",
                  locations=["Sunnyvale, CA"], sponsorship="U.S. Citizenship is Required"),
    ):
        chosen[rec["id"]] = rec
    return [chosen[k] for k in sorted(chosen)]


def print_numbers(feed_path, state_dir, now):
    """§6.9 on a full snapshot: what the first v2 run would do to these state files."""
    state, plan = run_plan(feed_path, state_dir, now)
    prev = {r["id"]: r for r in state.roles}
    active = [r for r in plan.rows if r.get("active")]
    by_co = jobwatch.Counter(r["company"] for r in active)
    why = jobwatch.Counter(next(r for r in plan.rows if r["id"] == i).get("why") for i in plan.untracked_now)
    reactivated = [i for i in plan.matched if i in prev and not prev[i].get("active")]
    keep_leaving = [i for i in plan.prev_active if i not in plan.matched
                    and jobwatch.has_keep_mark(state.marks, i, state.cfg.keep_marks)]
    gate = 100 * len(plan.newly_closed) / len(plan.prev_active) if plan.prev_active else 0
    print(f"active {len(active)} at {len(by_co)} companies, {len({r['group'] for r in active})} groups")
    print("top: " + " · ".join(f"{c} {n}" for c, n in by_co.most_common(8)))
    print(f"new (Telegram) {len(plan.new_ids)} · known silent {len(plan.known_silent)} · reactivated {len(reactivated)}")
    print(f"untracked {len(plan.untracked_now)} {dict(why)} · closed {len(plan.newly_closed)} · archive gate {gate:.1f} %")
    print(f"keep-marked rows leaving the active set: {len(keep_leaving)}")
    print("rejects at tracked companies: " + " · ".join(f"{k} {plan.rejects.get(k, 0)}"
                                                       for k in ("category", "phd", "title", "region", "sponsorship", "age")))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--feed", help="full listings.json snapshot (for --build-subset and the §6.9 numbers)")
    p.add_argument("--state-dir", default=REAL, help="state files to measure against (default tests/fixtures/real)")
    p.add_argument("--build-subset", action="store_true", help="rebuild fixtures/listings_subset.json from --feed")
    p.add_argument("--now", type=int, default=FROZEN_NOW, help="clock for the §6.9 numbers (default FROZEN_NOW)")
    args = p.parse_args(argv)
    if args.build_subset:
        if not args.feed:
            p.error("--build-subset needs --feed FULL_SNAPSHOT")
        subset = build_subset(args.feed)
        dump(SUBSET, subset)
        print(f"wrote {SUBSET} ({len(subset)} records)")
    dump(VECTORS, make_vectors())
    print(f"wrote {VECTORS}")
    if os.path.exists(SUBSET):
        dump(EXPECTED, make_expected(SUBSET))
        print(f"wrote {EXPECTED}")
    else:
        print(f"[warn] {SUBSET} missing — expected.json not written (run with --build-subset --feed …)", file=sys.stderr)
    if args.feed:
        print_numbers(args.feed, args.state_dir, args.now)
    return 0


if __name__ == "__main__":
    sys.exit(main())
