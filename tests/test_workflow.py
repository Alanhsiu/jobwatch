"""The workflows as shell: every `run:` block parses, actions are SHA-pinned, the commit step stages only the bot's
files, and the Notify step of jobwatch.yml makes the right alert decision for each exit code and gh outcome. The step's
script is executed for real, with a fake `gh` and `curl` first on PATH — no YAML library (CI has none) and no network."""

import os
import re
import shutil
import stat
import subprocess
import textwrap

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKFLOWS = os.path.join(ROOT, ".github", "workflows")
BOT = os.path.join(WORKFLOWS, "jobwatch.yml")
CI = os.path.join(WORKFLOWS, "ci.yml")

# GitHub runs an unspecified shell as `bash -e`, `shell: bash` as `bash -eo pipefail`; the step must behave under both.
SHELLS = [pytest.param(["bash", "-e"], id="bash -e"), pytest.param(["bash", "-eo", "pipefail"], id="pipefail")]

FAKE_GH = """#!/bin/bash
# `gh run list ...` prints ids.txt (fails when list_fails exists); `gh run view <id> --log` prints log_<id>.txt.
here=$(dirname "$0")
case "$1 $2" in
  "run list") [ -e "$here/list_fails" ] && { echo "gh: HTTP 500" >&2; exit 1; }; cat "$here/ids.txt";;
  "run view") cat "$here/log_$3.txt" 2>/dev/null || { echo "gh: run $3: log not found" >&2; exit 1; };;
  *) echo "unexpected: gh $*" >&2; exit 2;;
esac
"""
FAKE_CURL = """#!/bin/bash
printf '%s\\n<<END>>\\n' "$*" >> "$(dirname "$0")/curl.log"
"""

# Lines as `gh run view --log` prints them: "<job>\t<step>\t<timestamp> <text>"; processed workflow commands show as
# "##[error]", a log from a run that could not process them keeps "::error::".
FEED = "watch\tRun jobwatch\t2026-09-04T10:23:01.1234567Z ##[error]feed: fetch failed after 4 attempts: timeout\n"
FEED_RAW = "watch\tRun jobwatch\t2026-09-04T10:23:01.1234567Z ::error::feed: 412 records < min_records 1000\n"
OK = "watch\tRun jobwatch\t2026-09-04T08:23:01.0000000Z [ok] 269 active · +3 new\n"
CORRUPT = "watch\tRun jobwatch\t2026-09-04T08:23:01.0000000Z ##[error]seen.json is not valid JSON — fix or delete it\n"
ECHOED = ("watch\tNotify on failure\t2026-09-04T10:23:05.0000000Z   grep -qE "
          '"${tab}Run jobwatch${tab}.*(::error::|##\\[error\\])feed:" <<<"$log"\n')
RUN_LOG = "[info] fetching feed\n::error::feed: fetch failed after 4 attempts: timeout\n"


def run_blocks(path):
    """[(label, script)] for every step's `run:` — the `|` literal block dedented, or the inline one-liner."""
    lines = open(path, encoding="utf-8").read().splitlines()
    blocks, name, i = [], None, 0
    while i < len(lines):
        m = re.match(r"\s*- name: (.+)$", lines[i])
        if m:
            name = m.group(1).strip()
        m = re.match(r"(\s*)-?\s*run: (.*)$", lines[i])
        if not m:
            i += 1
            continue
        indent, value = len(m.group(1)), m.group(2).strip()
        if value == "|":
            body = []
            i += 1
            while i < len(lines) and (not lines[i].strip() or len(lines[i]) - len(lines[i].lstrip()) > indent):
                body.append(lines[i])
                i += 1
            script = textwrap.dedent("\n".join(body)) + "\n"
        else:
            script, i = value + "\n", i + 1
        blocks.append((name or script.splitlines()[0], script))
        name = None
    return blocks


def step_script(path, name):
    return dict(run_blocks(path))[name]


def bash_syntax_ok(script):
    """`bash -n` after replacing `${{ ... }}` expressions, which the runner substitutes before the shell sees them."""
    plain = re.sub(r"\$\{\{.*?\}\}", "EXPR", script)
    return subprocess.run(["bash", "-n"], input=plain, capture_output=True, text=True).returncode == 0


class NotifyStep:
    """Runs the Notify step's script in an isolated directory; `calls` are the curl invocations it made."""

    def __init__(self, tmp_path):
        self.dir = tmp_path
        self.script = tmp_path / "notify.sh"
        self.script.write_text(step_script(BOT, "Notify on failure"))
        for name, body in (("gh", FAKE_GH), ("curl", FAKE_CURL)):
            path = tmp_path / name
            path.write_text(body)
            path.chmod(path.stat().st_mode | stat.S_IEXEC)
        self.write("ids.txt", "")
        self.write(".jobwatch-run.log", RUN_LOG)

    def write(self, name, text):
        (self.dir / name).write_text(text)

    def run(self, shell, code="1", event="schedule", token="123:abc"):
        env = dict(os.environ, PATH=f"{self.dir}{os.pathsep}{os.environ['PATH']}", GH_TOKEN="x", T=token, C="42",
                   CODE=code, EVENT=event, URL="https://run/1")
        proc = subprocess.run([*shell, str(self.script)], cwd=self.dir, env=env, capture_output=True, text=True, timeout=30)
        assert proc.returncode == 0, proc.stderr
        return proc.stdout

    @property
    def calls(self):
        log = self.dir / "curl.log"
        return log.read_text().split("<<END>>\n")[:-1] if log.exists() else []


@pytest.fixture
def notify(tmp_path):
    return NotifyStep(tmp_path)


@pytest.mark.parametrize("path", [BOT, CI])
def test_every_run_block_parses(path):
    blocks = run_blocks(path)
    assert blocks, path
    for label, script in blocks:
        assert bash_syntax_ok(script), label


def test_actions_pinned_by_sha_with_version_comment():
    for path in (BOT, CI):
        uses = [line for line in open(path, encoding="utf-8") if "uses:" in line]
        assert uses, path
        for line in uses:
            assert re.search(r"uses: [\w./-]+@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+\s*$", line), line


def test_commit_step_stages_exactly_the_bot_files():
    script = step_script(BOT, "Commit state")
    assert "for f in roles.json seen.json meta.json README.md; do" in script
    assert "if grep -q '::notice::seeded companies.json' .jobwatch-run.log; then git add -- companies.json; fi" in script
    for never in ("status.json", "manual.json", "config.json"):
        assert never not in script
    assert script.count("git add --") == 2  # the loop and the seed; nothing else is ever staged
    assert 'git commit -m "jobwatch: update roles + state [skip ci]"' in script


def test_run_step_reports_python_exit_code_not_tee():
    script = step_script(BOT, "Run jobwatch")
    assert "set +e" in script and "| tee .jobwatch-run.log" in script
    assert "code=${PIPESTATUS[0]}" in script and 'echo "code=$code" >> "$GITHUB_OUTPUT"' in script


@pytest.mark.parametrize("shell", SHELLS)
def test_exit_2_alerts_at_once_with_the_error_tail(notify, shell):
    notify.write(".jobwatch-run.log", "[info] loading\n::error::roles.json is not valid JSON — fix or delete it\n")
    notify.run(shell, code="2")
    assert len(notify.calls) == 1
    assert "text=jobwatch run FAILED (exit 2): https://run/1\n::error::roles.json is not valid JSON" in notify.calls[0]
    assert "chat_id=42" in notify.calls[0] and "bot123:abc/sendMessage" in notify.calls[0]


@pytest.mark.parametrize("shell", SHELLS)
def test_exit_4_and_3_alert_without_consulting_run_history(notify, shell):
    notify.write("list_fails", "")  # gh must not even be needed
    for code in ("4", "3"):
        notify.run(shell, code=code)
    assert [c.split("text=")[1].splitlines()[0] for c in notify.calls] == [
        "jobwatch run FAILED (exit 4): https://run/1", "jobwatch run FAILED (exit 3): https://run/1"]


@pytest.mark.parametrize("shell", SHELLS)
def test_missing_code_and_push_failure_are_labelled(notify, shell):
    notify.run(shell, code="")   # run step cancelled or timed out before it reported
    notify.run(shell, code="0")  # bot succeeded, the commit/push step failed
    assert "text=jobwatch run FAILED (exit ?): https://run/1" in notify.calls[0]
    assert "text=jobwatch run FAILED (exit 0, commit/push failed): https://run/1" in notify.calls[1]


def test_no_token_sends_nothing(notify):
    notify.run(["bash", "-e"], code="2", token="")
    assert notify.calls == []


@pytest.mark.parametrize("event", ["push", "workflow_dispatch"])
def test_feed_failure_outside_the_schedule_is_silent(notify, event):
    notify.write("list_fails", "")  # the streak is not even consulted
    out = notify.run(["bash", "-e"], code="1", event=event)
    assert f"feed failure on a {event} run; the streak counts scheduled runs only" in out
    assert notify.calls == []


# ids = the two previous scheduled runs as `gh run list` returns them (newest first); logs keyed by id.
STREAK = [
    pytest.param("", {}, False, "first feed failure; waiting for a second", id="no-history"),
    pytest.param("11\n12\n", {"log_11.txt": OK, "log_12.txt": FEED}, False, "first feed failure", id="previous-ok"),
    pytest.param("11\n12\n", {"log_11.txt": CORRUPT, "log_12.txt": FEED}, False, "first feed failure", id="previous-red-not-feed"),
    pytest.param("11\n12\n", {"log_11.txt": ECHOED + OK}, False, "first feed failure", id="pattern-only-in-echoed-script"),
    pytest.param("11\n12\n", {"log_11.txt": FEED, "log_12.txt": OK}, True, "", id="second-consecutive"),
    pytest.param("11\n12\n", {"log_11.txt": FEED_RAW, "log_12.txt": OK}, True, "", id="second-consecutive-raw-annotation"),
    pytest.param("11\n", {"log_11.txt": FEED}, True, "", id="second-consecutive-short-history"),
    pytest.param("11\n12\n", {"log_11.txt": FEED, "log_12.txt": FEED}, False, "streak already alerted", id="third-consecutive"),
    pytest.param("11\n12\n", {"log_11.txt": FEED, "log_12.txt": FEED, "list_fails": ""}, True,
                 "could not read run history; alerting", id="gh-list-fails"),
    pytest.param("11\n12\n", {"log_12.txt": OK}, True, "could not read the log of run 11; alerting", id="gh-view-fails-previous"),
    pytest.param("11\n12\n", {"log_11.txt": FEED}, True, "", id="gh-view-fails-older"),
]


@pytest.mark.parametrize("shell", SHELLS)
@pytest.mark.parametrize("ids,files,alerts,message", STREAK)
def test_feed_failure_streak_decisions(notify, shell, ids, files, alerts, message):
    notify.write("ids.txt", ids)
    for name, text in files.items():
        notify.write(name, text)
    out = notify.run(shell, code="1")
    assert message in out
    assert len(notify.calls) == (1 if alerts else 0), out
    if alerts:
        assert "text=jobwatch run FAILED (exit 1): https://run/1\n::error::feed: fetch failed" in notify.calls[0]


@pytest.mark.skipif(shutil.which("jq") is None, reason="jq not installed")
def test_run_list_filter_keeps_the_two_newest_real_runs():
    """The --jq filter given to `gh run list`: cancelled/skipped runs are not part of a streak."""
    script = step_script(BOT, "Notify on failure")
    expr = re.search(r"--jq '([^']+)'", script).group(1)
    runs = ('[{"databaseId":5,"conclusion":"cancelled"},{"databaseId":4,"conclusion":"failure"},'
            '{"databaseId":3,"conclusion":"skipped"},{"databaseId":2,"conclusion":"success"},{"databaseId":1,"conclusion":"failure"}]')
    out = subprocess.run(["jq", "-r", expr], input=runs, capture_output=True, text=True, check=True).stdout
    assert out.split() == ["4", "2"]
