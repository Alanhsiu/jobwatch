import urllib.error

import jobwatch
from conftest import CREDS, FROZEN_NOW, cfg_with, make_row

PAGES = "https://alanhsiu.github.io/jobwatch/"
CFG = cfg_with()


def roles(n, company="TikTok", start=1, **over):
    return [make_row(i, company=company, **over) for i in range(start, start + n)]


def all_ids(rows):
    return {r["id"] for r in rows}


def chunk_ids(chunks):
    return set().union(*(c.ids for c in chunks)) if chunks else set()


def test_chunks_carry_ids():
    rows = roles(30) + roles(20, company="Cerebras", start=100) + roles(5, company="Apple", start=200)
    cfg = cfg_with(telegram=dict(CFG.telegram, chunk_chars=1200, max_messages_per_run=3, max_lines_per_company=50))
    chunks = jobwatch.digest_chunks(rows, cfg, PAGES)
    assert len(chunks) == 3
    ids = [c.ids for c in chunks]
    assert all(a.isdisjoint(b) for i, a in enumerate(ids) for b in ids[i + 1:])
    cut = all_ids(rows) - chunk_ids(chunks)
    assert chunk_ids(chunks) | cut == all_ids(rows) and cut
    for c in chunks:  # every id rendered in a chunk is in that chunk's ids and vice versa
        for r in rows:
            assert (f'"{r["url"]}"' in c.html) == (r["id"] in c.ids)


def test_chunk_never_splits_bullet():
    rows = roles(40)
    cfg = cfg_with(telegram=dict(CFG.telegram, chunk_chars=1500, max_messages_per_run=20, max_lines_per_company=99))
    chunks = jobwatch.digest_chunks(rows, cfg, PAGES)
    assert len(chunks) > 2
    bullets = [line for c in chunks for line in c.html.split("\n") if line.startswith("• ")]
    assert len(bullets) == 40 and all(line.endswith("BS/MS") for line in bullets)
    for c in chunks:
        assert "<b>TikTok</b> (40)" in c.html  # header repeated on every continuation
        assert c.html.count("<a href") == 2 * sum(1 for line in c.html.split("\n") if line.startswith("• ")) + (1 if c is chunks[0] else 0)


def test_chunk_limit_with_unicode():
    rows = [make_row(i, title=f"Ingénieur logiciel – données ✓ 東京 {i}", degrees=[]) for i in range(60)]
    cfg = cfg_with(telegram=dict(CFG.telegram, chunk_chars=1400, max_messages_per_run=50, max_lines_per_company=99))
    chunks = jobwatch.digest_chunks(rows, cfg, PAGES)
    assert len(chunks) >= 4
    assert all(len(c.html) <= 1400 for c in chunks)
    assert chunk_ids(chunks) == all_ids(rows)


def test_html_escaped():
    rows = roles(1, title='C++ & <b>Rust</b> "Engineer"', company="Snap <Inc>", location="A & B, CA")
    (c,) = jobwatch.digest_chunks(rows, CFG, PAGES)
    assert "<b>Snap &lt;Inc&gt;</b>" in c.html and "&lt;b&gt;Rust&lt;/b&gt; &quot;Engineer&quot;" in c.html
    assert "A &amp; B, CA" in c.html and "<b>Rust" not in c.html
    assert 'C++ & <b>Rust</b> "Engineer"' in c.plain


def test_non_http_url_plain():
    rows = roles(1, url="javascript:alert(1)")
    (c,) = jobwatch.digest_chunks(rows, CFG, PAGES)
    assert "javascript:" not in c.html
    assert "• [SWE] Software Engineer New Grad 1 — San Jose, CA · BS/MS" in c.html
    readme = jobwatch.render_jobs_list(rows, CFG)
    assert "javascript:" not in readme and "- Software Engineer New Grad 1 — San Jose, CA" in readme


def test_group_folded_all_locations_linked():
    a = make_row(1, title="ML Engineer Graduate", location="San Jose, CA", locations=["San Jose, CA"])
    b = make_row(2, title="ML Engineer Graduate (2026)", location="Seattle, WA", locations=["Seattle, WA"])
    c2 = make_row(3, title="ML Engineer Graduate", location="Seattle, WA", locations=["Seattle, WA"])
    (c,) = jobwatch.digest_chunks([b, a, c2], CFG, PAGES)
    bullets = [line for line in c.html.split("\n") if line.startswith("• ")]
    assert len(bullets) == 1
    line = bullets[0]
    assert f'<a href="{a["url"]}">ML Engineer Graduate</a>' in line  # newest posting carries the title link
    assert f'<a href="{a["url"]}">San Jose, CA</a>' in line and f'<a href="{b["url"]}">Seattle, WA</a> ×2' in line
    assert "(3 postings)" in line and "<b>TikTok</b> (3)" in c.html
    assert c.plain.count("https://example.com/job/") == 3
    assert c.ids == {a["id"], b["id"], c2["id"]}


def test_degree_tag_and_sponsors():
    rows = roles(1, degrees=["Bachelor's", "Master's", "PhD"], sponsorship="Offers Sponsorship")
    (c,) = jobwatch.digest_chunks(rows, CFG, PAGES)
    assert c.html.split("\n")[-1].endswith("· BS/MS/PhD · sponsors")
    rows = roles(1, degrees=[], sponsorship="Other")
    (c,) = jobwatch.digest_chunks(rows, CFG, PAGES)
    assert c.html.split("\n")[-1].endswith("San Jose, CA</a>")


def test_max_lines_per_company_then_more():
    rows = roles(96)
    (c,) = jobwatch.digest_chunks(rows, CFG, PAGES)
    lines = c.html.split("\n")
    assert sum(1 for line in lines if line.startswith("• ")) == 8
    assert lines[-1] == f'… <a href="{PAGES}#f=new&amp;co=tiktok">+88 more at TikTok</a> in the tracker'
    assert c.ids == all_ids(rows)
    assert "<b>96 new roles</b> · TikTok 96" in lines[0]
    (plain,) = jobwatch.digest_chunks(rows, CFG, None)
    assert plain.html.split("\n")[-1] == "… +88 more at TikTok in the tracker"


def test_max_messages_cut_ids_in_no_chunk():
    rows = [make_row(i, company=f"Co{i:02d}") for i in range(1, 41)]
    cfg = cfg_with(telegram=dict(CFG.telegram, chunk_chars=900, max_messages_per_run=2))
    chunks = jobwatch.digest_chunks(rows, cfg, PAGES)
    assert len(chunks) == 2
    cut = all_ids(rows) - chunk_ids(chunks)
    assert cut and chunk_ids(chunks) | cut == all_ids(rows)
    assert chunks[-1].html.endswith(f'<a href="{PAGES}#f=new">+{len(cut)} more roles — open the tracker</a>')
    assert f"+{len(cut)} more roles — open the tracker: {PAGES}#f=new" in chunks[-1].plain
    assert "(part 1/2)" in chunks[0].html and "(part 2/2)" in chunks[1].html


def test_header_deep_link_and_newly_tracked():
    rows = roles(2) + roles(1, company="Cerebras", start=10)
    (c,) = jobwatch.digest_chunks(rows, CFG, PAGES, newly_tracked=["cerebras"])
    head, tracker = c.html.split("\n")[:2]
    assert head == "<b>3 new roles</b> · TikTok 2 · Cerebras 1 · incl. newly tracked: cerebras (1)"
    assert tracker == f'<a href="{PAGES}#f=new">Open the tracker → New</a>'
    (c,) = jobwatch.digest_chunks(rows, CFG, PAGES, newly_tracked=[])
    assert "newly tracked" not in c.html
    (c,) = jobwatch.digest_chunks(rows, CFG, None)
    assert "#f=new" not in c.html and c.plain.startswith("3 new roles · TikTok 2 · Cerebras 1\n\nTikTok (2)")
    (c,) = jobwatch.digest_chunks(rows, cfg_with(telegram=dict(CFG.telegram, deep_link=False)), PAGES)
    assert "#f=new" not in c.html


def send(http, clock, chunk, deadline_in=180):
    return jobwatch.send_telegram(chunk, (CREDS["TELEGRAM_BOT_TOKEN"], CREDS["TELEGRAM_CHAT_ID"]), clock.t + deadline_in,
                                  jobwatch.Runtime(now=FROZEN_NOW, env={}, urlopen=http.urlopen, sleep=clock.sleep, monotonic=clock.monotonic))


def test_retry_429_honours_retry_after_and_deadline(http, clock):
    chunk = jobwatch.Chunk("<b>x</b>", "x", frozenset({"a"}))
    http.telegram = [("http", 429, {"ok": False, "parameters": {"retry_after": 7}}), ("http", 429, {"ok": False}, {"Retry-After": "3"}), "ok"]
    assert send(http, clock, chunk) == (True, None)
    assert clock.sleeps == [7, 3] and len(http.calls) == 3
    http.telegram = [("http", 429, {"ok": False, "parameters": {"retry_after": 500}})]
    ok, err = send(http, clock, chunk, deadline_in=20)
    assert ok is False and "deadline" in err and clock.sleeps == [7, 3]  # a 60 s clipped wait would cross it: no sleep
    http.telegram = [("http", 429, {"ok": False, "parameters": {"retry_after": 1}})] * 4
    ok, err = send(http, clock, chunk)
    assert ok is False and err == "HTTP 429 after 3 retries"


def test_http_400_plain_fallback_then_permanent(http, clock):
    chunk = jobwatch.Chunk("<b>x</b>", "x plain", frozenset({"a"}))
    http.telegram = [("http", 400, {"ok": False, "description": "Bad Request: can't parse entities"}), "ok"]
    assert send(http, clock, chunk) == (True, None)
    assert http.calls[0][1]["parse_mode"] == "HTML" and "parse_mode" not in http.calls[1][1]
    assert http.calls[1][1]["text"] == "x plain"
    http.telegram = [("http", 400, {"ok": False, "description": "Bad Request: chat not found"})] * 2
    ok, err = send(http, clock, chunk)
    assert ok is False and err == "HTTP 400 Bad Request: chat not found — did you message the bot first?"
    assert clock.sleeps == []


def test_permanent_and_transient_errors(http, clock):
    chunk = jobwatch.Chunk("<b>x</b>", "x", frozenset({"a"}))
    for code in (401, 403, 404):
        http.telegram = [("http", code, {"ok": False})]
        ok, err = send(http, clock, chunk)
        assert ok is False and err == jobwatch.TELEGRAM_HINTS[code]
    http.telegram = [("http", 502, {}), ("raise", urllib.error.URLError("boom")), "ok"]
    assert send(http, clock, chunk) == (True, None)
    assert clock.sleeps == [2, 6]
    http.telegram = [("http", 500, {"description": "x"})] * 3
    ok, err = send(http, clock, chunk)
    assert ok is False and err == "HTTP 500 x after 2 retries"
    http.telegram = [("ok", b'{"ok": false, "description": "Forbidden: bot was blocked"}')]
    assert send(http, clock, chunk) == (False, "ok:false Forbidden: bot was blocked")


def deliver_chunks(http, clock, chunks, env=None, cfg=CFG):
    rt = jobwatch.Runtime(now=FROZEN_NOW, env=env or {}, urlopen=http.urlopen, sleep=clock.sleep, monotonic=clock.monotonic)
    d = jobwatch.Delivery(mode="none", chunks=chunks, creds=True)
    jobwatch.send_chunks(d, chunks, (CREDS["TELEGRAM_BOT_TOKEN"], CREDS["TELEGRAM_CHAT_ID"]), cfg, rt)
    return d


def test_pacing_calls_sleep(http, clock):
    chunks = [jobwatch.Chunk(f"<b>{i}</b>", str(i), frozenset({str(i)})) for i in range(3)]
    d = deliver_chunks(http, clock, chunks)
    assert d.mode == "sent" and clock.sleeps == [1.1, 1.1] and d.delivered == {"0", "1", "2"}


def test_untracked_note_line():
    rows = roles(2)
    (c,) = jobwatch.digest_chunks(rows, CFG, PAGES, untracked_note="Note: 160 roles left your filters this run (settings or company list changed?)")
    assert c.html.split("\n")[-1] == "Note: 160 roles left your filters this run (settings or company list changed?)"
    assert c.plain.split("\n")[-1] == "Note: 160 roles left your filters this run (settings or company list changed?)"


def test_first_run_summary_format():
    rows = roles(3) + roles(2, company="Cerebras", start=10) + roles(1, company="Apple", start=20) + [make_row(30, active=False)]
    (c,) = jobwatch.summary_chunks(rows, PAGES)
    assert c.html == ("<b>jobwatch is live.</b> Watching 6 open new-grad roles at 3 companies. New postings arrive here; "
                      f"the README lists everything.\n<a href=\"{PAGES}\">Open the tracker</a>\n\nTikTok 3 · Cerebras 2 · Apple 1")
    assert c.plain.startswith("jobwatch is live. Watching 6 open") and PAGES in c.plain
    assert c.ids == {r["id"] for r in rows if r["active"]}
    (c,) = jobwatch.summary_chunks(rows, None)
    assert "<a" not in c.html


def test_log_lines_distinct(http, clock, capsys):
    chunks = [jobwatch.Chunk(f"<b>{i}</b>", f"plain {i}", frozenset({f"id{i}{j}" for j in range(4)})) for i in range(2)]
    d = deliver_chunks(http, clock, chunks)
    assert capsys.readouterr().out.strip() == "[telegram] sent 2/2 chunks (8 roles)"
    http.telegram = ["ok", ("http", 403, {})]
    d = deliver_chunks(http, clock, chunks, env={"GITHUB_ACTIONS": "true"})
    out = capsys.readouterr().out
    assert d.mode == "partial" and d.delivered == chunks[0].ids
    assert "::warning::telegram chunk 2/2 failed: HTTP 403 forbidden — the user blocked the bot or it is not in the chat — 4 role(s) will be re-announced next run" in out
    assert "plain 1" in out and "plain 0" not in out
    http.telegram = [("http", 403, {}), ("http", 403, {})]
    d = deliver_chunks(http, clock, chunks, env={"GITHUB_ACTIONS": "true"})
    out = capsys.readouterr().out
    assert d.mode == "failed" and "plain 0" in out and "plain 1" in out
    assert out.count("::warning::telegram chunk ") == 2  # every failed chunk is reported in failed mode too (§7.5)
    assert "::error::telegram: all 2 chunks failed: HTTP 403 forbidden — the user blocked the bot or it is not in the chat" in out
    assert out.count("::error::") == 1 and out.count("HTTP 403") == 3  # the error line names each distinct error once


def test_all_failed_error_line_keeps_root_cause_first(http, clock, capsys):
    chunks = [jobwatch.Chunk(f"<b>{i}</b>", f"plain {i}", frozenset({f"id{i}"})) for i in range(3)]
    http.telegram = [("http", 500, {})] * 3  # chunk 1 burns the 9 s budget on 2 s + 6 s retries; the rest hit the deadline
    cfg = cfg_with(telegram=dict(CFG.telegram, deadline_seconds=9))
    d = deliver_chunks(http, clock, chunks, env={"GITHUB_ACTIONS": "true"}, cfg=cfg)
    out = capsys.readouterr().out
    assert d.mode == "failed" and d.delivered == set()
    assert [err for _, err, _ in d.failed] == ["HTTP 500 after 2 retries", "delivery deadline reached", "delivery deadline reached"]
    assert "::warning::telegram chunk 1/3 failed: HTTP 500 after 2 retries — 1 role(s) will be re-announced next run" in out
    assert "::warning::telegram chunk 3/3 failed: delivery deadline reached — 1 role(s) will be re-announced next run" in out
    assert "::error::telegram: all 3 chunks failed: HTTP 500 after 2 retries; delivery deadline reached" in out


def test_in_quiet_hours():
    q = {"start": 23, "end": 8, "tz": "UTC"}
    assert jobwatch.in_quiet_hours(None, None) is False
    midnight = 1788566400  # 2026-09-05 00:00 UTC
    assert jobwatch.in_quiet_hours(midnight, q) is True
    assert jobwatch.in_quiet_hours(midnight + 8 * 3600, q) is False
    assert jobwatch.in_quiet_hours(midnight + 23 * 3600, q) is True
    assert jobwatch.in_quiet_hours(midnight + 12 * 3600, q) is False
    assert jobwatch.in_quiet_hours(midnight + 12 * 3600, {"start": 9, "end": 17, "tz": "UTC"}) is True
    assert jobwatch.in_quiet_hours(midnight + 12 * 3600, {"start": 12, "end": 12, "tz": "UTC"}) is False
    assert jobwatch.in_quiet_hours(midnight + 12 * 3600, {"start": 0, "end": 8, "tz": "America/Los_Angeles"}) is True  # 05:00 PDT
