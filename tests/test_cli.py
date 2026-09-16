import os

import pytest

import jobwatch
from conftest import read_json, snapshot


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for k in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_STEP_SUMMARY", "JOBWATCH_FORCE"):
        monkeypatch.delenv(k, raising=False)


def test_usage_error_exit_5(tmp_path, capsys):
    with pytest.raises(SystemExit) as e:
        jobwatch.main(["--bogus"])
    assert e.value.code == 5
    assert "[error]" in capsys.readouterr().err
    with pytest.raises(SystemExit) as e:
        jobwatch.main(["--explain", "only-one"])
    assert e.value.code == 5
    assert jobwatch.main(["--dry-run", "--state-dir", str(tmp_path / "missing")]) == 5
    assert "[error] --state-dir" in capsys.readouterr().err and not (tmp_path / "missing").exists()


def test_unexpected_exception_exits_2_not_1(state_dir, feed_file, monkeypatch, capsys):
    def boom(*args, **kwargs):
        raise RuntimeError("kaboom")
    monkeypatch.setattr(jobwatch, "build_plan", boom)
    before = snapshot(state_dir)
    assert jobwatch.main(["--feed", feed_file, "--state-dir", state_dir]) == 2
    err = capsys.readouterr().err
    assert "Traceback" in err and "RuntimeError: kaboom" in err
    assert "[error] internal error: RuntimeError: kaboom — a bug or a hand-edited state file" in err
    assert snapshot(state_dir) == before
    monkeypatch.setenv("GITHUB_ACTIONS", "true")  # the annotation the workflow greps for, and never the feed-failure prefix
    assert jobwatch.main(["--feed", feed_file, "--state-dir", state_dir]) == 2
    out = capsys.readouterr().out
    assert "::error::internal error: RuntimeError: kaboom" in out and "feed:" not in out


def test_feed_file_flag(state_dir, feed_file, capsys):
    assert jobwatch.main(["--dry-run", "--feed", feed_file, "--state-dir", state_dir]) == 0
    out = capsys.readouterr().out
    assert "[dry-run]" in out and "active" in out
    assert jobwatch.main(["--dry-run", "--feed", os.path.join(state_dir, "nope.json"), "--state-dir", state_dir]) == 1
    assert "feed: file not found" in capsys.readouterr().err


def test_state_dir_flag(state_dir, feed_file, tmp_path):
    before = set(os.listdir(state_dir))
    cwd = os.getcwd()
    os.chdir(tmp_path)
    try:
        assert jobwatch.main(["--no-notify", "--feed", feed_file, "--state-dir", state_dir]) == 0
    finally:
        os.chdir(cwd)
    assert not {"roles.json", "meta.json", "seen.json"} & set(os.listdir(tmp_path))  # nothing lands in the cwd
    assert set(os.listdir(state_dir)) == before | {"meta.json"}


def test_config_path_flag(state_dir, feed_file, tmp_path, capsys):
    cfg_path = tmp_path / "elsewhere.json"
    cfg_path.write_text('{"feed": {"min_records": 0, "min_active": 0, "min_active_ratio": 0.7, "required_keys": []}, "regions": ["TW"]}')
    os.remove(os.path.join(state_dir, "config.json"))
    assert jobwatch.main(["--no-notify", "--feed", feed_file, "--state-dir", state_dir, "--config", str(cfg_path)]) == 4  # TW-only: 0 matches
    assert jobwatch.main(["--no-notify", "--force", "--feed", feed_file, "--state-dir", state_dir, "--config", str(cfg_path)]) == 0
    meta = read_json(os.path.join(state_dir, "meta.json"))
    assert meta["config_source"] == "config.json" and meta["counts"]["active"] == 0
    assert meta["config_sha"] == jobwatch.blob_sha(cfg_path.read_bytes())


def test_explain_prints_verdict(state_dir, capsys):
    assert jobwatch.main(["--explain", "TikTok", "Machine Learning Engineer Graduate", "--degrees", "PhD", "--locations", "San Jose, CA",
                          "--state-dir", state_dir]) == 0
    out = capsys.readouterr().out
    assert "verdict: would NOT match" in out and "FAIL  phd" in out and "pass  company   keyword 'tiktok'" in out
    assert jobwatch.main(["--explain", "Cerebras", "Software Engineer New Grad", "--degrees", "Bachelor's,Master's",
                          "--locations", "Toronto, ON, Canada;Sunnyvale, CA", "--state-dir", state_dir]) == 0
    out = capsys.readouterr().out
    assert "verdict: would match" in out and "Toronto, ON, Canada → other, Sunnyvale, CA → US" in out
    assert jobwatch.main(["--explain", "Millennium Physician Group", "Analyst", "--state-dir", state_dir]) == 0
    assert "denied by ['millennium physician']" in capsys.readouterr().out


def test_version_flag(capsys):
    assert jobwatch.main(["--version"]) == 0
    assert capsys.readouterr().out.strip() == f"jobwatch {jobwatch.BOT_VERSION}" == "jobwatch 2.0.0"


def test_loud_line_without_creds_outside_actions(state_dir, feed_file, capsys):
    assert jobwatch.main(["--feed", feed_file, "--state-dir", state_dir]) == 0
    out = capsys.readouterr().out
    assert "[warn] No Telegram creds:" in out and "NOT marked seen" in out and "--no-notify" in out
    assert "[ok]" in out
    meta = read_json(os.path.join(state_dir, "meta.json"))
    assert meta["telegram"]["mode"] == "no_creds" and meta["counts"]["new_this_run"] > 0
    seen_before = read_json(os.path.join(os.path.dirname(__file__), "fixtures", "real", "seen.json"))
    assert len(read_json(os.path.join(state_dir, "seen.json"))) == len(seen_before) + meta["counts"]["silent_known_this_run"]
