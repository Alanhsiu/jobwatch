import os

import jobwatch
from conftest import REAL, VECTORS, cfg_with, read_json

CFG = cfg_with()
TABLE = {row["in"]: row["out"] for row in VECTORS["region"]}
KNOWN_OTHER_AT_TRACKED = {"London, UK", "Montreal, QC, Canada", "Toronto, ON, Canada", "Edinburgh, UK", "Cambridge, UK",
                          "Dublin, Ireland", "Vancouver, BC, Canada", "Bangalore, IN", "Berlin, DE"}


def by_class(expected):
    return [s for s, out in TABLE.items() if out == expected]


def test_table_us():
    us = by_class("US")
    assert {"SF", "Remote in USA (FL)", "Ontario, CA", "Canada, United States", "Vancouver, WA", "Melbourne, FL", "London, KY"} <= set(us)
    for s in us:
        assert jobwatch.loc_region(s) == "US", s


def test_table_other():
    other = by_class("other")
    assert {"Remote in Canada", "La Ronge, SK, Canada", "London", "Farringdon, London, UK", "Europe", "Bangalore, IN", "Berlin, DE"} <= set(other)
    for s in other:
        assert jobwatch.loc_region(s) == "other", s


def test_table_tw():
    tw = by_class("TW")
    assert set(tw) == {"Taipei, Taiwan", "Hsinchu", "New Taipei City, Taiwan"}
    for s in tw:
        assert jobwatch.loc_region(s) == "TW", s


def test_case_sensitive_state_codes():
    assert jobwatch.loc_region("Indianapolis, IN") == "US"
    assert jobwatch.loc_region("Somewhere, in") == "other"
    assert jobwatch.loc_region("Springfield, Il") == "other"
    assert jobwatch.loc_region("LA") == "US" and jobwatch.loc_region("la") == "US"  # exact-match table is normalised


def test_explicit_us_beats_non_us():
    assert jobwatch.loc_region("Canada, United States") == "US"
    assert jobwatch.loc_region("London, UK, USA") == "US"


def test_country_name_beats_state_code():
    assert jobwatch.loc_region("Toronto, ON, Canada") == "other"
    assert jobwatch.loc_region("La Ronge, SK, Canada") == "other"
    assert jobwatch.loc_region("Hyderabad, Telangana, India") == "other"


def test_foreign_city_with_matching_country_code_is_other():
    assert jobwatch.loc_region("Bangalore, IN") == "other"
    assert jobwatch.loc_region("Berlin, DE") == "other"


def test_foreign_city_with_unambiguous_state_code_is_us():
    for s in ("Vancouver, WA", "Dublin, OH", "Dublin, CA", "Melbourne, FL", "Paris, TX"):
        assert jobwatch.loc_region(s) == "US", s


def test_remote_rules():
    assert jobwatch.loc_region("Remote") == "US"
    assert jobwatch.loc_region("Remote in the US") == "US"
    assert jobwatch.loc_region("Remote in Germany") == "other"
    assert jobwatch.loc_region("Remote - EMEA") == "other"


def test_empty_locations_pass():
    assert jobwatch.region_ok([], CFG) is True
    assert jobwatch.role_region([]) == "unknown"
    assert jobwatch.loc_region("") == "other"
    assert jobwatch.region_ok([""], CFG) is False


def test_regions_empty_means_no_filter():
    assert jobwatch.region_ok(["London, UK"], cfg_with(regions=[])) is True
    assert jobwatch.region_ok(["London, UK"], CFG) is False
    assert jobwatch.region_ok(["Taipei, Taiwan"], cfg_with(regions=["US"])) is False
    assert jobwatch.region_ok(["London, UK", "NYC"], CFG) is True


def test_role_region_priority():
    assert jobwatch.role_region(["London, UK", "NYC"]) == "US"
    assert jobwatch.role_region(["London, UK", "Hsinchu"]) == "TW"
    assert jobwatch.role_region(["London, UK"]) == "other"


def test_no_other_at_tracked_companies_except_known_list(feed_subset):
    keywords = jobwatch.keyword_list(read_json(os.path.join(REAL, "companies.json")), [])
    seen = set()
    for r in feed_subset:
        if not r.get("active") or not jobwatch.match_company(r["company_name"], keywords, CFG.deny):
            continue
        role = jobwatch.normalize_record(r)
        if jobwatch.classify(role, CFG, set(), 0) == "region":
            seen |= set(role["locations"])
    assert seen and seen <= KNOWN_OTHER_AT_TRACKED
