import os

import pytest

import jobwatch
from conftest import EXPECTED, REAL, VECTORS, cfg_with, read_json

CFG = cfg_with()
KEYWORDS = jobwatch.keyword_list(read_json(os.path.join(REAL, "companies.json")), [])
DENY = jobwatch.DEFAULT_CONFIG["deny"]


def test_norm_vectors():
    for case in VECTORS["norm"]:
        assert jobwatch.norm(case["in"]) == case["out"], case
    assert jobwatch.norm("d-Matrix") == "d matrix"
    assert jobwatch.norm("Susquehanna International Group (SIG)") == "susquehanna international group sig"
    assert jobwatch.norm("D. E. Shaw & Co") == "d e shaw co"


def test_company_single_word_whole_word():
    assert jobwatch.match_company("Snap Inc.", KEYWORDS, DENY) == "snap"
    assert jobwatch.match_company("Snapdocs", KEYWORDS, DENY) is None
    assert jobwatch.match_company("Cruise", KEYWORDS, DENY) == "cruise"
    assert jobwatch.match_company("Millennium Management", KEYWORDS, DENY) == "millennium"
    assert jobwatch.match_company("Meta", KEYWORDS, DENY) == "meta"
    assert jobwatch.match_company("Metaphor Labs", KEYWORDS, DENY) is None


def test_company_multi_word_bounded():
    assert jobwatch.match_company("Upscale AI", KEYWORDS, DENY) is None
    assert jobwatch.match_company("Scale AI", KEYWORDS, DENY) == "scale ai"
    assert jobwatch.match_company("Akuna Capital University", KEYWORDS, DENY) == "akuna"
    assert jobwatch.match_company("Bloomberg Industry Group", KEYWORDS, DENY) == "bloomberg"
    assert jobwatch.match_company("Susquehanna International Group (SIG)", KEYWORDS, DENY) == "sig"  # first in sorted order
    assert jobwatch.match_company("D. E. Shaw", KEYWORDS, DENY) == "d e shaw"


def test_punctuated_keyword():
    assert "d matrix" in KEYWORDS and "d-matrix" not in KEYWORDS
    assert jobwatch.match_company("d-Matrix", KEYWORDS, DENY) == "d matrix"
    assert jobwatch.match_company("D-MATRIX Inc", KEYWORDS, DENY) == "d matrix"


def test_deny_bounded():
    assert jobwatch.match_company("Millennium Physician Group", KEYWORDS, DENY) is None
    assert jobwatch.match_company("Millennium Space Systems, a Boeing Company", KEYWORDS, DENY) is None
    assert jobwatch.match_company("Snap-on", KEYWORDS, DENY) is None
    assert jobwatch.match_company("Snap Finance", KEYWORDS, DENY) is None
    assert jobwatch.match_company("Cruise Planners", KEYWORDS, DENY) is None
    assert jobwatch.match_company("Kraken Robotics", KEYWORDS, DENY) is None
    assert jobwatch.match_company("Kraken", KEYWORDS, DENY) == "kraken"
    assert jobwatch.match_company("Wolverine Trading", KEYWORDS, DENY) == "wolverine"


def test_empty_keyword_warned():
    warnings = []
    kws = jobwatch.keyword_list(["tiktok", "  ", "---", "TikTok"], warnings)
    assert kws == ["tiktok"]
    assert warnings and "normalises to ''" in warnings[0]


def v1_match(name, companies):
    """The matcher this release replaces (multi-word substring, single-word whole word, exact deny)."""
    n = jobwatch.norm(name)
    if n in {jobwatch.norm(x) for x in ("snap-on", "coherent", "primetals", "metalcraft", "metalsa", "millennium space systems",
                                         "snap finance", "wolverine world wide", "kraken robotics")}:
        return False
    words = set(n.split())
    return any((frag in n) if " " in frag else (frag in words) for frag in companies)


def test_live_feed_diff_is_exactly_two_names(feed_subset):
    v1_companies = read_json(os.path.join(REAL, "companies.json"))
    names = {r["company_name"] for r in feed_subset if r.get("active") and r.get("source") != "synthetic"}
    flips = {n for n in names if bool(jobwatch.match_company(n, KEYWORDS, DENY)) != v1_match(n, v1_companies)}
    assert flips == {"Upscale AI", "Millennium Physician Group"}


HW_ADMITTED = [
    "Software Engineer New Grad", "Embedded Software Engineer New Grad", "Software Integration Engineer New Grad",
    "GPU Architecture Engineer New Grad", "Graphics Software Content Engineer", "Early Career Flight Software Engineer",
    "Cellular Layer-1 Control Software Development Engineer - Wireless Technologies & Ecosystems",
    "Cellular Power Optimization Software Engineer - Wireless Technologies & Ecosystems",
]
HW_REJECTED = ["GPU Verification Engineer New Grad", "RTL Design Engineer", "ASIC Design Verification Engineer",
               "FPGA Engineer New Grad", "Software R&D Engineer New Grad - VLSI Physical Design", "Hardware Integration Engineer",
               "PCIe Architect", "Signal Integrity Engineer 1"]


def test_hardware_rescue_include_exclude():
    for t in HW_ADMITTED:
        assert jobwatch.category_tag("Hardware", t, CFG) == "HW", t
    for t in HW_REJECTED:
        assert jobwatch.category_tag("Hardware", t, CFG) is None, t
    assert jobwatch.category_tag("Software", "Anything", CFG) == "SWE"
    assert jobwatch.category_tag("AI/ML/Data", "Anything", CFG) == "ML"
    assert jobwatch.category_tag("Quant", "Anything", CFG) == "Quant"
    assert jobwatch.category_tag("Product", "Software Product Manager", CFG) is None
    off = cfg_with(hardware_rescue=dict(jobwatch.DEFAULT_CONFIG["hardware_rescue"], enabled=False))
    assert jobwatch.category_tag("Hardware", "Software Engineer New Grad", off) is None


def test_phd_only_degrees():
    assert jobwatch.phd_excluded(["PhD"], "Machine Learning Engineer Graduate", CFG) is True
    assert jobwatch.phd_excluded(["PhD", "MD"], "Research Engineer", CFG) is True


def test_masters_plus_phd_kept():
    assert jobwatch.phd_excluded(["Master's", "PhD"], "Software Engineer New Grad - Hardware Tools", CFG) is False
    assert jobwatch.phd_excluded(["Bachelor's", "Master's", "PhD"], "Quantitative AI Technical Staff", CFG) is False


def test_empty_degrees_research_fallback():
    assert jobwatch.phd_excluded([], "Research Scientist, Alignment", CFG) is True
    assert jobwatch.phd_excluded([], "Software Engineer", CFG) is False
    assert jobwatch.phd_excluded(["Bachelor's"], "Research Scientist - Takeoff Intel", CFG) is False  # re-admitted


def test_explicit_phd_title_always():
    assert jobwatch.phd_excluded(["Master's", "PhD"], "Applied Research Scientist – New Grad - PhD", CFG) is True
    assert jobwatch.phd_excluded(["Bachelor's", "Master's"], "Quantitative Researcher - Ph.D", CFG) is True
    assert jobwatch.phd_excluded(["Bachelor's"], "Postdoc Fellow", CFG) is True
    assert jobwatch.phd_excluded(["Bachelor's"], "Doctoral Researcher", CFG) is True


TITLE_EXCLUDED = [
    "Data Collection Operator - Optimus", "Data Collection Operator - Optimus - Afternoon Shift", "Manufacturing Trainee - Megafactory",
    "Data Labeler - Tesla AI", "Data Creator", "Analyst Student Worker", "Humanoid Robot Pilot",
    "Software Engineer 2 / Senior Software Engineer - Commerce Platforms", "Senior Machine Learning Engineer - Economics",
    "Staff Software Engineer", "Software Engineer II", "Sr. Data Scientist", "Engineering Manager", "Software Engineering Intern",
    "Co-op Software Developer", "Mail Clerk", "Data Annotator",
    "Shift Left Test Engineer 2026 New Grad",  # role-type fragment ("shift"): never waived by a new-grad signal
]
TITLE_KEPT = [
    "Member of Technical Staff", "Quantitative AI Technical Staff", "Quantitative Research Analyst University Graduate",
    "Machine Learning Engineer Graduate - Lead Ads", "Knowledge Graph Developer", "Senior Software Engineer, New Grad",
    "Software Engineer", "Internal Tools Engineer", "Software Engineer 2026",
    "Analyst", "Staff Accountant Analyst",
]


def test_title_exclude_table():
    for t in TITLE_EXCLUDED:
        assert jobwatch.title_excluded(t, CFG) is True, t
    for t in TITLE_KEPT:
        assert jobwatch.title_excluded(t, CFG) is False, t


def test_seniority_waived_by_new_grad():
    assert jobwatch.title_excluded("Senior Software Engineer, New Grad", CFG) is False
    assert jobwatch.title_excluded("Senior Software Engineer", CFG) is True
    assert jobwatch.title_excluded("Senior Data Collection Operator - University Graduate", CFG) is True  # role-type never waived


def test_zero_false_exclusions_on_real_keep_marks(feed_subset):
    status = jobwatch.parse_marks(read_json(os.path.join(REAL, "status.json")))
    keep = {i for i in status if jobwatch.has_keep_mark(status, i, CFG.keep_marks)}
    live = {"simplify:" + r["id"]: r for r in feed_subset if r.get("active")}
    checked = 0
    for rid in keep & set(live):
        r = live[rid]
        assert not jobwatch.phd_excluded(r["degrees"], r["title"], CFG), r["title"]
        assert not jobwatch.title_excluded(r["title"], CFG), r["title"]
        checked += 1
    assert checked >= 50
    assert not keep & set(EXPECTED["golden"]["untracked"])


def test_group_key_vectors():
    for case in VECTORS["group_key"]:
        assert jobwatch.group_key(case["company"], case["title"]) == case["out"], case
    assert jobwatch.group_key("TikTok", "Software Engineer New Grad (2026)") == jobwatch.group_key("TikTok", "Software Engineer New Grad")
    assert jobwatch.group_key("NVIDIA", "ML Engineer – New Grad") == "nvidia|ml engineer new grad"


@pytest.mark.parametrize("degrees, tag", [(["Bachelor's", "Master's"], "BS/MS"), (["PhD", "Bachelor's"], "BS/PhD"), ([], ""), (["MBA"], "")])
def test_degree_tag(degrees, tag):
    assert jobwatch.degree_tag(degrees) == tag


def test_classify_order_and_sticky_age(frozen_now):
    old = jobwatch.normalize_record({"id": "x", "company_name": "TikTok", "title": "Software Engineer", "category": "Software",
                                     "date_posted": frozen_now - 100 * 86400, "locations": ["SF"], "degrees": [], "sponsorship": "Other"})
    assert jobwatch.classify(dict(old), CFG, set(), frozen_now) == "age"
    assert jobwatch.classify(dict(old), CFG, {"simplify:x"}, frozen_now) is None
    assert jobwatch.classify(dict(old, category="Product"), CFG, set(), frozen_now) == "category"
    assert jobwatch.classify(dict(old, degrees=["PhD"], title="Data Collection Operator"), CFG, set(), frozen_now) == "phd"
    assert jobwatch.classify(dict(old, title="Data Collection Operator", locations=["London, UK"]), CFG, set(), frozen_now) == "title"
    assert jobwatch.classify(dict(old, locations=["London, UK"], sponsorship="Does Not Offer Sponsorship"), CFG, set(), frozen_now) == "region"
    assert jobwatch.classify(dict(old, sponsorship="Does Not Offer Sponsorship"), CFG, set(), frozen_now) == "sponsorship"


def test_parse_marks_vectors():
    for case in VECTORS["parse_marks"]:
        assert jobwatch.parse_marks({case["id"]: case["in"]}).get(case["id"]) == case["out"], case["label"]
