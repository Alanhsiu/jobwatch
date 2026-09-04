import locale
import os

import pytest

import jobwatch
from conftest import write_json


def test_atomic_write_replaces_file(tmp_path):
    p = tmp_path / "x.json"
    p.write_text("old")
    jobwatch.atomic_write(str(p), b"new")
    assert p.read_bytes() == b"new"
    assert os.listdir(tmp_path) == ["x.json"]


def test_atomic_write_leaves_no_temp_on_error(tmp_path, monkeypatch):
    p = tmp_path / "x.json"
    p.write_text("old")

    def boom(*a):
        raise OSError("disk full")
    monkeypatch.setattr(jobwatch.os, "replace", boom)
    with pytest.raises(OSError):
        jobwatch.atomic_write(str(p), b"new")
    assert os.listdir(tmp_path) == ["x.json"]
    assert p.read_text() == "old"


def test_atomic_write_utf8_under_cp1252_locale(tmp_path, monkeypatch):
    monkeypatch.setattr(locale, "getpreferredencoding", lambda *a: "cp1252")
    p = tmp_path / "x.txt"
    jobwatch.atomic_write(str(p), "Zürich — 東京")
    assert p.read_bytes() == "Zürich — 東京".encode("utf-8")
    assert jobwatch.read_text(str(p)) == "Zürich — 東京"
    write_json(str(tmp_path / "y.json"), {"k": "Zürich"})
    assert jobwatch.load_json(str(tmp_path / "y.json"), dict, None) == {"k": "Zürich"}


def test_write_if_changed_noop_on_identical_bytes(tmp_path):
    p = tmp_path / "x.json"
    assert jobwatch.write_if_changed(str(p), b"a") is True
    before = os.stat(p)
    assert jobwatch.write_if_changed(str(p), b"a") is False
    assert os.stat(p).st_mtime_ns == before.st_mtime_ns
    assert jobwatch.write_if_changed(str(p), b"b") is True


def test_load_json_missing_returns_default(tmp_path):
    assert jobwatch.load_json(str(tmp_path / "none.json"), list, "dflt") == "dflt"


def test_load_json_corrupt_exits_2(tmp_path):
    p = tmp_path / "seen.json"
    p.write_text("[1, 2,")
    with pytest.raises(jobwatch.Abort) as e:
        jobwatch.load_json(str(p), list, [])
    assert e.value.code == 2 and "seen.json" in e.value.message


def test_load_json_wrong_type_exits_2(tmp_path):
    p = tmp_path / "roles.json"
    p.write_text('{"a": 1}')
    with pytest.raises(jobwatch.Abort) as e:
        jobwatch.load_json(str(p), list, [])
    assert e.value.code == 2 and "roles.json" in e.value.message


def test_load_status_corrupt_is_lenient_and_disables_prune(state_dir):
    with open(os.path.join(state_dir, "status.json"), "w") as f:
        f.write("{corrupt")
    state = jobwatch.load_state(jobwatch.Paths(state_dir, os.path.join(state_dir, "config.json")))
    assert state.marks_unreliable is True
    assert state.marks == {}
    assert any("status.json" in w and "pruning disabled" in w for w in state.warnings)


def test_readme_not_utf8_exits_2(state_dir):
    with open(os.path.join(state_dir, "README.md"), "wb") as f:
        f.write(b"# jobwatch\n\xff\xfe latin-1 bytes\n")
    with pytest.raises(jobwatch.Abort) as e:
        jobwatch.load_state(jobwatch.Paths(state_dir, os.path.join(state_dir, "config.json")))
    assert e.value.code == 2 and e.value.message == "README.md is not UTF-8"
    os.remove(os.path.join(state_dir, "README.md"))
    assert jobwatch.load_state(jobwatch.Paths(state_dir, os.path.join(state_dir, "config.json"))).readme is None
