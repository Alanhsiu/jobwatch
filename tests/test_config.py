import json
import os
import subprocess

import pytest

import jobwatch
from conftest import FIXTURES, read_json, write_json

CONFIG_VECTORS = read_json(os.path.join(FIXTURES, "config_vectors.json"))["cases"]


def load(tmp_path, obj):
    p = tmp_path / "config.json"
    if obj is not None:
        write_json(str(p), obj)
    return jobwatch.load_config(str(p))


def test_defaults_when_file_absent(tmp_path):
    cfg, info = load(tmp_path, None)
    assert cfg.data == jobwatch.DEFAULT_CONFIG
    assert info == {"source": "defaults", "sha": None, "warnings": []}


def test_file_replaces_top_level_key(tmp_path):
    cfg, info = load(tmp_path, {"regions": ["US"], "deny": ["acme"]})
    assert cfg.regions == ["US"]
    assert cfg.deny == ["acme"]  # replaced, not merged with the default list
    assert cfg.max_age_days == 75
    assert info["source"] == "config.json"


def test_unknown_key_warns(tmp_path):
    cfg, info = load(tmp_path, {"bogus": 1})
    assert cfg.data == jobwatch.DEFAULT_CONFIG
    assert info["warnings"] == ["config.json: unknown key 'bogus' ignored"]


@pytest.mark.parametrize("bad, key", [
    ({"regions": "US"}, "regions"),
    ({"regions": ["EU"]}, "regions"),
    ({"max_age_days": 0}, "max_age_days"),
    ({"max_age_days": True}, "max_age_days"),
    ({"feed": {"min_records": -1}}, "feed.min_records"),
    ({"feed": dict(jobwatch.DEFAULT_CONFIG["feed"], min_active_ratio=2)}, "feed.min_active_ratio"),
    ({"telegram": "loud"}, "telegram"),
    ({"telegram": dict(jobwatch.DEFAULT_CONFIG["telegram"], quiet_hours={"start": 25, "end": 8, "tz": "UTC"})}, "telegram.quiet_hours"),
    ({"feed_url": "http://insecure"}, "feed_url"),
    ({"title_seniority": ["zzz"]}, "title_seniority"),
])
def test_wrong_type_exits_2_names_key(tmp_path, bad, key):
    with pytest.raises(jobwatch.Abort) as e:
        load(tmp_path, bad)
    assert e.value.code == 2
    assert key in e.value.message


def test_corrupt_json_exits_2(tmp_path):
    (tmp_path / "config.json").write_text("{nope")
    with pytest.raises(jobwatch.Abort) as e:
        jobwatch.load_config(str(tmp_path / "config.json"))
    assert e.value.code == 2 and "config.json" in e.value.message


def test_nested_object_missing_subkeys_filled_from_defaults(tmp_path):
    quiet = {"start": 23, "end": 8, "tz": "UTC"}
    cfg, info = load(tmp_path, {"feed": {"min_records": 0}, "hardware_rescue": {"enabled": False}, "telegram": {"quiet_hours": quiet}})
    assert cfg.feed == dict(jobwatch.DEFAULT_CONFIG["feed"], min_records=0)
    assert cfg.hardware_rescue == dict(jobwatch.DEFAULT_CONFIG["hardware_rescue"], enabled=False)
    assert cfg.telegram == dict(jobwatch.DEFAULT_CONFIG["telegram"], quiet_hours=quiet)
    assert info["warnings"] == [
        "config.json: feed is missing min_active, min_active_ratio, required_keys — filled from defaults",
        "config.json: hardware_rescue is missing include, exclude — filled from defaults",
        "config.json: telegram is missing html, max_lines_per_company, max_messages_per_run, pace_seconds, chunk_chars, "
        "deep_link, deadline_seconds — filled from defaults",
    ]
    cfg, info = load(tmp_path, {"telegram": jobwatch.DEFAULT_CONFIG["telegram"]})
    assert info["warnings"] == []


@pytest.mark.parametrize("case", CONFIG_VECTORS, ids=[c["label"] for c in CONFIG_VECTORS])
def test_shared_config_vectors(tmp_path, case):
    """Verdicts shared with lib.js validateConfig (tests/js/lib.test.mjs runs the same rows)."""
    if not case["ok"]:
        with pytest.raises(jobwatch.Abort) as e:
            load(tmp_path, case["in"])
        assert e.value.code == 2 and case["error_key"] in e.value.message
        return
    cfg, info = load(tmp_path, case["in"])
    filled = case.get("filled", {})
    for key, subkeys in filled.items():
        assert cfg.data[key] == {**jobwatch.DEFAULT_CONFIG[key], **case["in"][key]}
    fills = [f"config.json: {key} is missing {', '.join(subkeys)} — filled from defaults" for key, subkeys in filled.items()]
    assert [w for w in info["warnings"] if w.endswith("— filled from defaults")] == fills
    for key in case.get("unknown", []):
        assert f"config.json: unknown key {key!r} ignored" in info["warnings"]
    assert len(info["warnings"]) == len(fills) + len(case.get("unknown", []))


def test_bad_fragment_falls_back_with_warning(tmp_path):
    cfg, info = load(tmp_path, {"title_exclude": ["senior", "(unclosed"], "phd_title": ["fine"]})
    assert cfg.title_exclude == jobwatch.DEFAULT_CONFIG["title_exclude"]
    assert cfg.phd_title == ["fine"]
    assert info["warnings"] == ["config.json: title_exclude[1] does not compile — using default"]


@pytest.mark.parametrize("frag", [
    pytest.param("a{99999999999999999999}", id="repetition count overflows"),
    pytest.param("(" * 5000 + "a" + ")" * 5000, id="nesting exceeds the recursion limit"),
])
def test_fragment_re_compile_cannot_handle_falls_back_with_warning(tmp_path, frag):
    """re.compile raises OverflowError/RecursionError here, not re.error; V8 accepts both, so the page cannot pre-empt."""
    cfg, info = load(tmp_path, {"title_keep": [frag]})
    assert cfg.title_keep == jobwatch.DEFAULT_CONFIG["title_keep"]
    assert info["warnings"] == ["config.json: title_keep[0] does not compile — using default"]
    assert cfg.keep_pattern.search("New Grad Software Engineer")


@pytest.mark.parametrize("key", ["title_exclude", "title_keep"])
@pytest.mark.parametrize("empty", ["", "  "])
def test_empty_fragment_falls_back_with_warning(tmp_path, key, empty):
    cfg, info = load(tmp_path, {key: ["senior", empty]})
    assert getattr(cfg, key) == jobwatch.DEFAULT_CONFIG[key]
    assert info["warnings"] == [f"config.json: {key}[1] is empty — using default"]
    assert not jobwatch.title_excluded("Software Engineer - Backend", cfg)  # the empty fragment would have hit " - "
    assert jobwatch.title_excluded("Senior Software Engineer", cfg)


@pytest.mark.parametrize("frags, titles", [
    (["(?P<g>cuda)", "(?P<g>kernel)"], ["CUDA Engineer", "Kernel Engineer", "Compiler Engineer"]),  # same group name twice
    (["(x)", r"(a)\1"], ["aa engineer", "x engineer", "a engineer"]),  # \1 would renumber behind another group
    (["senior)(?:staff", "intern"], ["Software Intern", "seniorstaff engineer", "senior engineer"]),  # `)(` breaks out of the wrapper
])
def test_fragment_list_keeps_each_fragments_standalone_meaning(tmp_path, frags, titles):
    """Joined into one alternation these lists compile yet stop matching what each fragment matches alone (review finding 5)."""
    cfg, info = load(tmp_path, {"hardware_rescue": dict(jobwatch.DEFAULT_CONFIG["hardware_rescue"], include=frags),
                                "title_keep": frags})
    assert info["warnings"] == []
    assert cfg.hardware_rescue["include"] == frags and cfg.title_keep == frags
    for title in titles:
        alone = any(jobwatch.fragment(f).search(title) for f in frags)
        assert bool(cfg.hw_include.search(title)) is alone, title
        assert bool(cfg.keep_pattern.search(title)) is alone, title
    assert cfg.hw_include.search(titles[0]) and cfg.hw_include.search(titles[1])
    assert cfg.hw_include.search(titles[0]).group(0).lower() in titles[0].lower()  # a Match, like re.Pattern.search
    assert jobwatch.AnyFragment([]).search("anything") is None


def test_fragments_compile_bounded():
    assert jobwatch.fragment("sr\\.?").search("Sr. Software Engineer")
    assert jobwatch.fragment("sr\\.?").search("SR ENGINEER")
    assert not jobwatch.fragment("sr\\.?").search("srx engineer")
    assert not jobwatch.fragment("intern").search("Internal Tools Engineer")
    assert jobwatch.fragment("intern").search("Software Intern")
    assert jobwatch.bounded("snap").search("snap inc")
    assert not jobwatch.bounded("snap").search("snapshot inc")
    assert jobwatch.bounded("scale ai").search("scale ai") and not jobwatch.bounded("scale ai").search("upscale ai")


def test_config_sha_equals_git_blob_sha(tmp_path):
    p = tmp_path / "config.json"
    p.write_text('{"regions": ["US"], "pages_url": null}\n  \n', encoding="utf-8")
    _, info = jobwatch.load_config(str(p))
    expected = subprocess.run(["git", "hash-object", str(p)], capture_output=True, text=True, check=True).stdout.strip()
    assert info["sha"] == expected
    assert len(info["sha"]) == 40


def test_config_sha_null_when_defaults(tmp_path):
    _, info = load(tmp_path, None)
    assert info["sha"] is None and info["source"] == "defaults"


def test_quiet_hours_validation_and_unknown_tz_warns(tmp_path):
    tg = dict(jobwatch.DEFAULT_CONFIG["telegram"], quiet_hours={"start": 23, "end": 8, "tz": "America/Los_Angeles"})
    cfg, info = load(tmp_path, {"telegram": tg})
    assert cfg.telegram["quiet_hours"] == {"start": 23, "end": 8, "tz": "America/Los_Angeles"}
    assert info["warnings"] == []
    tg["quiet_hours"] = {"start": 23, "end": 8, "tz": "Mars/Olympus"}
    cfg, info = load(tmp_path, {"telegram": tg})
    assert cfg.telegram["quiet_hours"] is None
    assert info["warnings"] == ["config.json: telegram.quiet_hours.tz 'Mars/Olympus' is unknown — quiet hours off"]
    tg["quiet_hours"] = {"start": 23, "end": 8, "tz": "UTC", "note": "x"}  # extra keys are tolerated like everywhere else
    cfg, info = load(tmp_path, {"telegram": tg})
    assert cfg.telegram["quiet_hours"] == {"start": 23, "end": 8, "tz": "UTC"}
    assert info["warnings"] == ["config.json: telegram.quiet_hours: unknown key 'note' ignored"]
    for bad in ({"start": "23", "end": 8, "tz": "UTC"}, {"start": 23, "tz": "UTC"}, {"start": 23, "end": 8, "tz": None}):
        with pytest.raises(jobwatch.Abort) as e:
            load(tmp_path, {"telegram": dict(tg, quiet_hours=bad)})
        assert e.value.code == 2 and "telegram.quiet_hours" in e.value.message


def test_defaults_are_json_serialisable_and_self_consistent():
    json.dumps(jobwatch.DEFAULT_CONFIG)
    assert set(jobwatch.DEFAULT_CONFIG["title_seniority"]) <= set(jobwatch.DEFAULT_CONFIG["title_exclude"])
    assert set(jobwatch.DEFAULT_CONFIG) == {k.split(".")[0] for k in jobwatch.CONFIG_TYPES}
    assert os.path.basename(jobwatch.DEFAULT_CONFIG["feed_url"]) == "listings.json"
