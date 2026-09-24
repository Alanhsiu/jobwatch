# jobwatch

jobwatch watches new-grad **SWE / ML / Quant** roles at the companies *you* choose and tells you only about the new ones.
A small Python bot runs on GitHub Actions every ~2 hours, pulls Simplify's New-Grad-Positions feed, filters it and sends
a Telegram digest of the postings you have not seen. A one-page **tracker** on GitHub Pages lists every open role and lets
you move each one through your pipeline (seen → applied → OA → interview → offer) from a phone or a laptop; your marks
sync between devices through this repo. No servers, no database, no cost — a public repo, Actions, Pages and a Telegram
bot token. This repo's tracker: **[alanhsiu.github.io/jobwatch](https://alanhsiu.github.io/jobwatch/)** (a fork gets its own at `https://<owner>.github.io/<repo>/`).

<!-- JOBS:HEAD:START -->
_282 open new-grad roles at 56 companies · list last changed 2026-09-24 · scans every ~2 h_ · **[Open the tracker](https://alanhsiu.github.io/jobwatch/)** · [Full list ↓](#current-roles) · TikTok 104 · ByteDance 36 · Palantir 10 · Apple 9 · Amazon 7 · Anduril 7 · Old Mission 6 · Akuna Capital University 5 · …
<!-- JOBS:HEAD:END -->

## How it works

**Feed.** [Simplify's New-Grad-Positions](https://github.com/SimplifyJobs/New-Grad-Positions) `listings.json` (~20k
records, ~3k live, refreshed about every 30 min). The bot scans every ~2 h (`23 */2 * * *` UTC) and right after you push
`jobwatch.py`, `config.json` or `companies.json` to `main`; GitHub may delay scheduled runs by minutes to hours.

**Filter**, in this order, for every live record:
1. **Company** — the name must contain one of your `companies.json` keywords as whole words on a normalised name
   (`d-matrix` matches `d-Matrix`; `snap` matches `Snap Inc.` but not `Snapchat`). A **deny list** removes look-alikes
   (`Snap-on`, `Millennium Physician Group`).
2. **Category** — Simplify's Software, AI/ML/Data or Quant. A **Hardware** role is rescued when its title looks like
   software (`software`, `cuda`, `compiler`, `kernel`, `firmware`, `embedded`, …) and not like silicon work (`rtl`,
   `asic`, `verification`, `physical design`, …).
3. **Degrees** — PhD-only roles are dropped using the feed's `degrees` field (PhD listed without a Bachelor's/Master's).
   `PhD` / `postdoc` / `doctoral` in the title always drops; "Research Scientist" drops only when the feed lists no degrees.
4. **Title** — senior / staff / principal / manager / director / "Software Engineer II" are dropped unless the title also
   says new grad, graduate, campus or early career; operator, labeler, annotator, technician, intern, co-op, trainee, pilot
   and similar are dropped regardless.
5. **Region** — US or Taiwan. `Remote`, `Remote in USA` / `Remote in US` count as US; `Remote in Canada` (or any other
   country) does not. Foreign cities and countries are recognised (`London, UK` and `Toronto, ON, Canada` are out;
   `Vancouver, WA` and `Dublin, OH` are in). No location at all passes.
6. **Sponsorship** — `Does Not Offer Sponsorship` / `U.S. Citizenship is Required` are dropped.
7. **Age** — a role must be ≤ 75 days old the first time it is seen; after that it is *sticky* and stays active exactly
   as long as the feed lists it.

Postings with the same company and title (parentheticals ignored) fold into one **group** row (`×2 · San Jose, CA;
Seattle, WA`); marks are always per posting. A role that leaves the feed becomes **closed**; one that is still listed but
no longer passes your filters becomes **not tracked**, with the reason (PhD-only, title, region, category, sponsorship,
company removed). Both stay visible under All / Closed / Untracked, and anything you marked is kept.

**Telegram.** One digest per scan that found something new: a header (`3 new roles · TikTok 2 · Cerebras 1`) linking to
the tracker's New view, then one block per company and one bullet per group — `[ML] Title — San Jose, CA · Seattle, WA
(2 postings) · BS/MS` — with every location linking to its own posting. A company folds after 8 lines into `+N more at
TikTok` (a link to that list); a run sends at most 4 messages and the rest follow ~2 h later. A role is announced once,
and only after Telegram accepted the message. The very first run sends a summary instead of a digest.

**Tracker.** Views (Inbox, New, Pipeline, Saved, All, …), one-tap Seen / Applied / Dismiss, notes, stars, undo, keyboard
shortcuts, the company list and settings editor, a Rescan button, CSV/JSON export. Marks live in `status.json` in this
repo and merge between devices last-writer-wins; without a token the page is a read-only mirror.

## Setup (~15 min)

1. **Telegram bot.** Message **@BotFather** → `/newbot` → copy the token. Send your bot any message (otherwise it cannot
   write to you). Message **@userinfobot** for your numeric chat id.
2. **Repo** — public (Pages is free only on public repos; nothing secret is stored here). **Fork** this repo, or start
   **fresh** from a complete copy of it (clone → push to a new repo, or GitHub's *Use this template* when it is enabled).
   Copy everything, not a hand-picked subset: `ci.yml` runs `tests/`, `tools/`, `e2e/` and `ruff.toml` on every push
   and stays red without them (drop `.github/workflows/ci.yml` and `.github/dependabot.yml` if you want the bot alone).
   Either way, before opening the tracker: Actions tab → enable workflows; add the secrets (step 3); commit
   `status.json` = `{}` and `manual.json` = `[]`; delete `seen.json` (so your first run sends *your* summary, not this
   repo's memory); optionally `roles.json` = `[]`; edit `companies.json` to your list.
3. **Secrets.** Repo → Settings → Secrets and variables → Actions: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
4. **Pages.** Settings → Pages → Deploy from a branch → `main`, `/ (root)`. The tracker is at `https://<owner>.github.io/<repo>/`.
5. **First run.** Pushing `jobwatch.py`, `config.json` or `companies.json` to `main` runs the bot at once; otherwise
   Actions → **jobwatch** → Run workflow (tick `dry_run` to rehearse without writing or sending). It writes `roles.json`,
   `meta.json`, `seen.json`, fills the two generated sections of this README and sends the Telegram summary.
6. **Sync token (optional).** The page reads your public files without a token — a token is only needed to write.
   GitHub → Settings → Developer settings → Fine-grained tokens: *Only select repositories* → this repo; permissions
   **Contents: Read and write** and **Actions: Read and write** (for Rescan). Tracker → **Sync** → `owner/repo` + token →
   **Save & verify**. Repeat per device; the token never leaves that browser.
7. **iPhone.** Share → **Add to Home Screen**. Safari deletes a site's storage after 7 days without a visit; the Home
   Screen app has its own storage — paste the token there once.
8. **Quiet hours (optional).** The bot scans every ~2 h around the clock. Settings → Quiet hours (e.g. 23–8
   `America/Los_Angeles`) holds digests until the first scan after the window.

## Using the tracker

- **Views.** Inbox (active, unmarked), New (Inbox ∩ since your last visit or the last 36 h), Pipeline (applied → offer,
  grouped by stage with dates and a "no update 3w" nudge), Saved (★), All (with a hide-closed toggle) and, under More,
  each stage plus Closed and Untracked. Chips SWE / ML / Quant / HW, search and sort intersect any view; the URL hash
  holds the view, so a link reproduces it.
- **Marks.** Quick actions Seen / Applied / Dismiss, a stage select, ★ and a note per role. Changes sync within ~2 s;
  **Undo** in the toast (or `u`) restores exactly what was there, history included.
- **Groups.** One row per company + title with `×N` and a chip per posting (own link, own stage). Seen / Dismiss / ★
  apply to members still "to review"; Applied and later stages go to the single open member — with two or more the row
  expands and asks *Which posting?*
- **Company actions.** `Seen all` / `Dismiss all` in the company header; one Undo covers all of them.
- **Keyboard.** `?` lists the shortcuts; `j` / `k` move, `u` (or Ctrl+Z) undoes. Ignored while you type.
- **NEW badge** on roles that appeared since your last visit; the New tab counts the same set.
- **Pills.** The scan pill says when the bot last ran — "scanned 2h ago" with a token (from the Actions API) or "bot
  alive 14h ago" without one (from `meta.json`; the bot commits only when something changed, at least once a day). The
  sync pill reads Synced / Syncing… / N unsaved / Sync failing / Read-only / Local only; the footer repeats it in words.
- **Banners** are specific: new roles since your visit, sync off on this device, a sync error with its reason, offline
  with the pending count, `roles.json` failed to load, bot silent for > 26 h, settings changed since the last scan,
  marks on this device that are not in your repo (once, after upgrading — Discard unless you recognise them), a newer
  page version exists.
- **Companies dialog.** Every keyword with its active count (`0 ever` = never matched a name in the feed), the names it
  matched and `denied N`; add (previews how it will match, e.g. `d matrix`), remove (confirms when it hides roles),
  **Block this name** (adds to `config.deny`), **Rescan now** (dispatches the workflow and reports the outcome
  truthfully: "+3 new roles", "no new matches", "Scan failed"). Saving also triggers a scan within a minute.
- **Settings.** Theme; toggles for Hardware rescue, the Research-Scientist rule, regions US / TW and quiet hours; the
  `config.json` editor with Validate / Save / Reset to defaults; Export CSV / JSON; "Clear local marks on this device".

## Configuration

`config.json` is optional — without it the defaults in `jobwatch.py` apply. Create it from Settings → Save (writes the
effective config) or by hand. A key in the file **replaces** the default for that key (lists are not merged; a nested object such as `feed` or
`telegram` may omit sub-keys — they are filled from the defaults with a warning in `meta.json`); an unknown
key warns; a wrong type stops the run (exit 2) naming the key; a regex fragment that does not compile falls back to its
default with a warning in `meta.json`. Every change needs a scan — saving from Settings triggers one.

| Key | Default | Effect |
|---|---|---|
| `feed_url` | Simplify `listings.json` | Feed URL (`https://`). |
| `regions` | `["US", "TW"]` | Regions kept; `[]` = no region filter. |
| `categories` | `["Software", "Software Engineering", "AI/ML/Data", "Data Science, AI & Machine Learning", "Quant"]` | Simplify categories kept. |
| `hardware_rescue` | `{"enabled": true, "include": [...], "exclude": [...]}` | Admit `Hardware` roles whose title matches an include fragment and no exclude fragment. |
| `title_exclude` | regex fragments | Titles dropped (`senior`, `staff … engineer`, `operator`, `intern`, `trainee`, …). |
| `title_seniority` | subset of `title_exclude` | The fragments a `title_keep` hit waives. |
| `title_keep` | `["new grad", "graduate", "campus", "early careers?", "entry level", …]` | New-grad signals. |
| `phd_title` | `["ph\\.?\\s?d", "postdoc", "post-doc", "post doc", "doctoral"]` | Always dropped, whatever `degrees` says. |
| `research_title` | `["research scientist"]` | Dropped only when the feed lists no degrees. |
| `bs_ms_degrees` | `["Bachelor's", "Master's", "Associate's", "MBA"]` | A role is PhD-only iff `PhD` is listed and none of these. |
| `deny` | list of names | Company names (normalised, whole words) never matched. |
| `bad_sponsorship` | `["U.S. Citizenship is Required", "Does Not Offer Sponsorship"]` | Sponsorship values dropped. |
| `max_age_days` · `archive_days` | `75` · `180` | Age limit for *new* ids · how long closed / untracked rows without a keep-mark stay in `roles.json`. |
| `keep_marks` | `["applied", "oa", "interview", "offer", "rejected"]` | Stages (plus any ★ or note) that exempt a row from pruning. |
| `feed` | `{"min_records": 1000, "min_active": 200, "min_active_ratio": 0.7, "required_keys": [...]}` | Feed sanity gates (exit 1, nothing written). |
| `archive_gate` | `{"max_closed_fraction": 0.5, "min_prev_active": 20}` | Refuse to close more than half of the active roles in one run (exit 4; `force` overrides). |
| `telegram` | `{"html": true, "max_lines_per_company": 8, "max_messages_per_run": 4, "pace_seconds": 1.1, "chunk_chars": 3500, "deep_link": true, "deadline_seconds": 180, "quiet_hours": null}` | Digest shape; `quiet_hours` = `{"start": 23, "end": 8, "tz": "America/Los_Angeles"}` holds digests in the window. |
| `readme.collapse_over` | `20` | Companies with more roles than this render collapsed in the list below. |
| `pages_url` | `null` | Overrides the derived tracker URL (custom domains, local runs). |

Regex fragments are wrapped as `(?<![a-z0-9])(?:FRAG)(?![a-z0-9])`, case-insensitive, identically in Python and in the
page's validator — use only the shared subset (`\b \s \w ? + * | () [] \.`). `companies.json` is a JSON array of
lowercase keywords, edited from the Companies dialog or by hand.

## State files, backup, restore, reset

| File | Written by | Shape | Safe to delete? |
|---|---|---|---|
| `roles.json` | bot | array of roles, active and archived | Yes — rebuilt on the next run; archived history is lost. |
| `meta.json` | bot | run metadata, per-keyword counts, warnings | Yes — recreated; the scan pill reads "unknown" until then. |
| `seen.json` | bot | sorted ids already announced | Yes — the next run sends the summary and re-seeds (no per-role re-pings). |
| `status.json` | tracker (and `tools/backfill_marks.py`, run by you) | `{id: {s, star, note, t, h}}` or `{id: {d}}` | **No** — your marks. Reset = commit `{}` after hard-reloading every device. |
| `companies.json` | tracker; the bot only seeds it when absent | array of keywords | Yes — re-seeded with the defaults. |
| `manual.json` | tracker | roles you added by hand | Yes, if you have none. |
| `config.json` | tracker Settings, or you | object | Yes — the defaults apply. |
| `README.md` | bot, only between the two marker pairs | — | — |

- **Backup:** `git clone --depth=1 https://github.com/<owner>/<repo> jw-backup && tar czf jw-backup.tgz jw-backup`.
- **Restore marks:** `git checkout <sha> -- status.json && git commit -m "restore marks" && git push`, then Settings →
  Clear local marks on each device (or just wait: last-writer-wins adopts the repo copy for anything older).
- **Reset the bot's memory:** delete or empty `seen.json` → the next run sends the summary only and re-seeds.
- **`tools/backfill_marks.py`** (once, locally): reads the git history of `status.json` and gives every legacy mark its
  real change time and stage history, so Pipeline shows dates. `python3 tools/backfill_marks.py` prints the diff;
  `--write` applies it; review, commit, push. Idempotent — existing times are never overwritten.

## Running and testing locally

```
python3 jobwatch.py --dry-run --verbose --feed listings.json --state-dir /tmp/jw     # always --dry-run first
python3 jobwatch.py --explain "NVIDIA" "GPU Architecture Engineer New Grad" --degrees "Master's" --locations "Santa Clara, CA"
```
`--dry-run` runs the whole pipeline, gates included, prints counts, the would-be Telegram text and the files that would
change, and writes nothing. `--feed` takes a local snapshot (`curl -o listings.json <feed_url>`); `--state-dir` points at
a *copy* of the state files — never run inside your clone without it. A run without `--dry-run` and without Telegram
credentials writes files and prints a loud line saying the new roles were **not** marked seen (`--no-notify` marks them
seen without alerts). Never hand-commit `roles.json`, `seen.json`, `meta.json` or the generated README sections.

Page: `cp -r . /tmp/jw-page && cd /tmp/jw-page && python3 -m http.server 8000`, open `http://localhost:8000/`, and in
Sync save `owner/repo` **without** a token for read-only testing. Never paste a token into a `file://` page (the page
refuses). Tests: `python3 -m pytest -q`, `ruff check jobwatch.py tools tests`, `node --test 'tests/js/*.test.mjs'`,
`python3 tests/check_html.py`; Playwright: `cd e2e && npm ci`, then from the repo root `PW_CHANNEL=chrome node --test
'e2e/*.spec.mjs'` (system Chrome; CI installs chromium). Details in [DEVELOPING.md](DEVELOPING.md).

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Nothing on Telegram | The run log's annotations say why: `400 chat not found` → message the bot first; `403` → you blocked the bot; `401` → wrong token. Digests are held during quiet hours; a role is announced once — check the New view. |
| Red run, exit 1 | Feed unreachable or degenerate (too few records, schema drift, live count < 70 % of the last run) — nothing written. One Telegram after the second consecutive scheduled failure. Set `feed_url` if Simplify moved the file. |
| Red run, exit 2 | A state or config file is corrupt or the wrong shape — the message names it; fix or delete it. Also any unexpected internal error (traceback in the run log). Nothing written. |
| Red run, exit 3 | Files were written and committed, but every Telegram message failed; the roles are re-announced next run. |
| Red run, exit 4 | Gate: `refused to close N roles in one run` (feed hiccup?) or 0 matches with a non-empty company list. Re-run with the `force` input if it is real. |
| "Sync failing" banner | The reason is in the banner: token invalid or expired → new token; can't write → give it Contents: Read and write; repo or file not found → check `owner/repo`; `status.json` not valid JSON → fix it on GitHub. Marks stay safe on the device until Retry succeeds. |
| Read-only / rate limit | Without a token the page never calls the GitHub API (so the anonymous 60/h limit cannot bite) and cannot write; it mirrors the Pages copy, up to 10 min behind. Add a token to write. |
| Page shows old data | Pages caches for up to 10 min; the page tolerates old data in both directions. Hard-reload once after a release. |
| Scheduled runs late or gone | GitHub delays cron under load and disables schedules after 60 days without commits; the bot's heartbeat commit (at most one a day) prevents that, and any push re-enables. |

## What is public

In a public repo anyone can read the role list (`roles.json`, this README), your **stages per company** in `status.json`
(and its git history), your notes, `companies.json`, `manual.json` and `config.json`. Not public: the Telegram token and
chat id (Actions secrets) and your GitHub token (stored only in your browser, only after it verified, never on a
`file://` page). Shipped mitigations: `noindex`, `no-referrer`, `rel="noopener noreferrer"` on every link, no personal
names in code or comments. Keep notes free of anything you would not put in a public commit. **Private-repo recipe:**
GitHub Pro or the Student Pack allows Pages on a private repo — move `index.html`, `assets/`, `manifest.webmanifest`
and `.nojekyll` into `docs/`, set Pages to `/docs`, and give every device a token: the page's same-origin fetch of
`roles.json` 404s and it falls back to the Contents API.

## Current roles
<!-- JOBS:START -->
<details>
<summary>TikTok (104)</summary>

- [Ecosystem Analyst Graduate - LLM/Enforcement - TikTok Live](https://lifeattiktok.com/search/7687813753283332357) — LA · posted 2026-09-23 · ML · BS
- [Ecosystem Analyst Graduate - TikTok LIVE](https://lifeattiktok.com/search/7687814085886527797) — LA · posted 2026-09-23 · ML · BS
- [Machine Learning Engineer Graduate - E-Commerce Recommendation Video](https://lifeattiktok.com/search/7686999927260105013) · [2](https://lifeattiktok.com/search/7678145401619237173) — San Jose, CA; Seattle, WA · posted 2026-09-18 · ML · BS
- [Data Engineer Graduate](https://lifeattiktok.com/search/7681779180341709109) — San Jose, CA · posted 2026-09-07 · ML · BS/MS
- [Machine Learning Engineer Graduate - E-Commerce Knowledge Graph](https://lifeattiktok.com/search/7679156878833682693) — San Jose, CA · posted 2026-08-29 · ML · BS/MS
- [Data Engineer Graduate - Data Platform E-commerce](https://lifeattiktok.com/search/7676253726624024837) — San Jose, CA · posted 2026-08-26 · ML · BS/MS
- [Data Engineer Graduate - Data Platform Global Live](https://lifeattiktok.com/search/7678120538997098805) · [2](https://lifeattiktok.com/search/7675484418022181173) — San Jose, CA · posted 2026-08-26 · ML · BS/MS
- [Machine Learning Engineer Graduate - E-Commerce Supply Chain & Logistics](https://lifeattiktok.com/search/7675843332462872885) · [2](https://lifeattiktok.com/search/7675844938504702213) — Seattle, WA; San Jose, CA · posted 2026-08-20 · ML · BS/MS
- [Graduate Software Engineer - TikTok Search Data Infra](https://lifeattiktok.com/search/7675829388634392837) — San Jose, CA · posted 2026-08-20 · SWE · BS/MS
- [Machine Learning Engineer Graduate - E-Commerce Governance](https://lifeattiktok.com/search/7674023327725373701) · [2](https://lifeattiktok.com/search/7674025781001062709) — San Jose, CA; Seattle, WA · posted 2026-08-17 · ML · BS/MS
- [Data Scientist Graduate - Multimedia](https://lifeattiktok.com/search/7673672141010815237) · [2](https://lifeattiktok.com/search/7670288355678177589) — San Jose, CA · posted 2026-08-15 · ML · BS/MS
- [Software Engineer Graduate - Foundation Platform](https://lifeattiktok.com/search/7673674252889246005) · [2](https://lifeattiktok.com/search/7670276769459456309) — San Jose, CA · posted 2026-08-14 · SWE · BS/MS
- [Software Engineer Graduate - Ads Infra](https://lifeattiktok.com/search/7673409179353139461) — San Jose, CA · posted 2026-08-14 · SWE · BS
- [Software Engineer Graduate - Video-on-Demand Algorithm](https://lifeattiktok.com/search/7673674249270839557) · [2](https://lifeattiktok.com/search/7670282906426476853) — San Jose, CA · posted 2026-08-14 · SWE · BS/MS
- [LLM Post-Training Engineer Graduate - Research & Product](https://lifeattiktok.com/search/7673672141012093189) — San Jose, CA · posted 2026-08-14 · ML · MS
- [Software Engineer Graduate - Media Engine](https://lifeattiktok.com/search/7673667938889009461) — San Jose, CA · posted 2026-08-14 · SWE · MS
- [Backend Software Engineer Graduate - Creation Platform](https://lifeattiktok.com/search/7673669198965278981) · [2](https://lifeattiktok.com/search/7670292836050422021) — San Jose, CA · posted 2026-08-14 · SWE · BS/MS
- [Software Engineer Graduate - Recommendation Infrastructure](https://lifeattiktok.com/search/7673284715407886597) — San Jose, CA · posted 2026-08-13 · SWE · BS
- [Backend Software Engineer New Grad - Creator Strategy](https://lifeattiktok.com/search/7672976491146004741) — San Jose, CA · posted 2026-08-13 · SWE · BS
- [Software Engineer Graduate - Recommendation Architecture - Feeds Infrastructure](https://lifeattiktok.com/search/7672530785573980421) — Seattle, WA · posted 2026-08-13 · SWE · BS
- [Graduate Software Engineer - Media Engine](https://lifeattiktok.com/search/7670367152357673221) — San Jose, CA · posted 2026-08-12 · SWE · BS
- [Large Language Model Post-training Engineer Graduate - Research & Product](https://lifeattiktok.com/search/7670285949976201477) — San Jose, CA · posted 2026-08-12 · ML · BS
- [Software Engineer Graduate - Recommendation](https://lifeattiktok.com/search/7672517471946000645) — San Jose, CA · posted 2026-08-12 · SWE · BS
- [Machine Learning Engineer Graduate - E-Commerce Recommendation Mall](https://lifeattiktok.com/search/7672915427278457141) · [2](https://lifeattiktok.com/search/7672911151560296709) — San Jose, CA; Seattle, WA · posted 2026-08-12 · ML · BS
- [Machine Learning Engineer Graduate - TikTok Vertical Recommendation](https://lifeattiktok.com/search/7672532275557583157) — San Jose, CA · posted 2026-08-12 · ML · BS
- [Backend Engineer Graduate - TikTok Vertical Recommendation Architecture - 2027 Start](https://lifeattiktok.com/search/7672532801686571317) — San Jose, CA · posted 2026-08-12 · SWE · BS
- [Big Data Engineer Graduate - TikTok Recommendation Architecture](https://lifeattiktok.com/search/7672518398222387461) — San Jose, CA · posted 2026-08-12 · ML · BS
- [AI Infrastructure Engineer Graduate - Recommendation & LLM](https://lifeattiktok.com/search/7672654026594093317) — San Jose, CA · posted 2026-08-12 · ML · BS
- [Machine Learning Engineer Graduate - E-Commerce Recommendation Foundation](https://lifeattiktok.com/search/7672880386574338309) · [2](https://lifeattiktok.com/search/7672882500030138629) — Seattle, WA; San Jose, CA · posted 2026-08-12 · ML · BS
- [Recommendation Architecture AI/ML Infrastructure Engineer Graduate - Data-Arch-Tiktok Live](https://lifeattiktok.com/search/7670876337129425205) — San Jose, CA · posted 2026-08-07 · ML · BS/MS
- [Backend Software Engineer Graduate - Data Lifecycle Management](https://lifeattiktok.com/search/7670391173613160757) — San Jose, CA · posted 2026-08-07 · SWE · BS/MS
- [Backend Software Engineer Graduate - Privacy and Security - Product](https://lifeattiktok.com/search/7670387719826786565) — San Jose, CA · posted 2026-08-07 · SWE · BS/MS
- [Machine Learning Engineer Graduate - E-Commerce Recommendation/Search Alliance](https://lifeattiktok.com/search/7669913085331409205) · [2](https://lifeattiktok.com/search/7669910326745434421) — San Jose, CA; Seattle, WA · posted 2026-08-06 · ML · BS
- [Machine Learning Engineer Graduate - E-Commerce Recommendation Live](https://lifeattiktok.com/search/7670285495593273605) · [2](https://lifeattiktok.com/search/7670285949553707317) — San Jose, CA; Seattle, WA · posted 2026-08-06 · ML · BS
- [Software Engineer Graduate - Data Arch - E-commerce](https://lifeattiktok.com/search/7668582542044072245) — Seattle, WA · posted 2026-08-06 · SWE · BS/MS
- [Software Engineer Graduate - Multiple Teams](https://lifeattiktok.com/search/7668582086900680965) — Seattle, WA · posted 2026-08-06 · SWE · BS/MS
- [Software Engineer Graduate - Global E-commerce-Search - 2027 Start](https://lifeattiktok.com/search/7670558992960358661) — Seattle, WA · posted 2026-08-06 · SWE · BS/MS
- [Graduate Software Engineer - Global CRM](https://lifeattiktok.com/search/7668554579301124357) — San Jose, CA · posted 2026-08-06 · SWE · BS/MS
- [Backend Engineer Graduate](https://lifeattiktok.com/search/7665989305914984709) — San Jose, CA · posted 2026-08-04 · SWE · BS
- [AI Engineer Graduate - Client Architecture - 2027 Start](https://lifeattiktok.com/search/7664978367107713333) — San Jose, CA · posted 2026-08-04 · ML · BS
- [Frontend Software Engineer Graduate - Global E-commerce](https://lifeattiktok.com/search/7668828193675036981) — Seattle, WA · posted 2026-08-04 · SWE · BS
- [Data Engineer Graduate - Monetization Data](https://lifeattiktok.com/search/7668550561096665397) — San Jose, CA · posted 2026-08-04 · ML · BS/MS
- [Mobile Software Engineer Graduate - Global E-commerce](https://lifeattiktok.com/search/7668831181590513925) — San Jose, CA · posted 2026-08-04 · SWE · BS
- [Backend Engineer Graduate - User Growth](https://lifeattiktok.com/search/7665986019233958197) — San Jose, CA · posted 2026-08-04 · SWE · BS
- [Backend Software Engineer Graduate - Global E-commerce](https://lifeattiktok.com/search/7668827379083823413) · [2](https://lifeattiktok.com/search/7668824169648097541) — Seattle, WA; San Jose, CA · posted 2026-08-04 · SWE · BS
- [Graduate Software Engineer](https://lifeattiktok.com/search/7668566347702569269) — San Jose, CA · posted 2026-08-04 · SWE · BS/MS
- [Machine Learning Engineer Graduate - Commerce Ads - 2027 Start](https://lifeattiktok.com/search/7669711968024430853) — San Jose, CA · posted 2026-08-04 · ML · BS
- [Machine Learning Engineer Graduate - Ads Signal & Measurement](https://lifeattiktok.com/search/7669700358734170373) — San Jose, CA · posted 2026-08-04 · ML · BS/MS/PhD
- [Backend Software Engineer Graduate - Digital Content Center](https://lifeattiktok.com/search/7668843238309824773) — San Jose, CA · posted 2026-08-04 · SWE · BS/MS
- [Machine Learning Engineer New Grad - Performance Monetization](https://lifeattiktok.com/search/7669691374918011141) — San Jose, CA · posted 2026-08-04 · ML · BS
- [Machine Learning Engineer Graduate - Data Search Recommendation Global E-Commerce](https://lifeattiktok.com/search/7668384123840514309) — Seattle, WA · posted 2026-08-04 · ML · BS/MS
- [Frontend Software Engineer Graduate - Global CRM](https://lifeattiktok.com/search/7668561079544154373) — San Jose, CA · posted 2026-08-04 · SWE · BS/MS
- [Graduate Software Engineer - Transaction Platform](https://lifeattiktok.com/search/7668557209047894325) — San Jose, CA · posted 2026-08-04 · SWE · BS/MS
- [Frontend Software Engineer New Grad - Ads Interface](https://lifeattiktok.com/search/7668569995571726597) — San Jose, CA · posted 2026-08-04 · SWE · BS/MS
- [Machine Learning Engineer Graduate - Brand Ads](https://lifeattiktok.com/search/7668663594419374341) — San Jose, CA · posted 2026-08-04 · ML · MS
- [Graduate Software Engineer - Ads Interface](https://lifeattiktok.com/search/7668855346857019701) — San Jose, CA · posted 2026-08-04 · SWE · BS/MS
- [Software Engineer New Grad - Ads Infrastructure](https://lifeattiktok.com/search/7668879883938203957) — San Jose, CA · posted 2026-08-04 · SWE · BS/MS
- [Machine Learning Engineer New Grad - Search Ads](https://lifeattiktok.com/search/7669698543896054069) — San Jose, CA · posted 2026-08-04 · ML · BS/MS/PhD
- [Machine Learning Engineer Graduate - App Ads and Gaming](https://lifeattiktok.com/search/7669709290431236357) — San Jose, CA · posted 2026-08-04 · ML · BS
- [Graduate Machine Learning Engineer](https://lifeattiktok.com/search/7669702699627661573) — San Jose, CA · posted 2026-08-04 · ML · MS
- [Machine Learning Engineer Graduate - Lead Ads](https://lifeattiktok.com/search/7669707604717209861) — San Jose, CA · posted 2026-08-04 · ML · BS/MS/PhD
- [Machine Learning Engineer New Grad - Recommendation](https://lifeattiktok.com/search/7663389745178757429) — San Jose, CA · posted 2026-08-03 · ML · BS
- [Research Scientist New Grad - Recommendation](https://lifeattiktok.com/search/7663388039600883973) — San Jose, CA · posted 2026-08-03 · ML · BS/PhD
- [Machine Learning Engineer New Grad - Trust and Safety](https://lifeattiktok.com/search/7665991852209932597) — San Jose, CA · posted 2026-08-03 · ML · BS/MS
- [Machine Learning Engineer Graduate - Trust and Safety](https://lifeattiktok.com/search/7665994926854555909) — Seattle, WA · posted 2026-08-03 · ML · BS/MS
- [Research Engineer Graduate - Monetization Technology - Business Integrity](https://lifeattiktok.com/search/7667769079948347701) — San Jose, CA · posted 2026-08-03 · ML · BS/MS
- [Research Scientist - Monetization Technology - Business Integrity](https://lifeattiktok.com/search/7667770207780194613) — San Jose, CA · posted 2026-08-03 · ML · BS/MS
- [Backend Software Engineer Graduate - Risk & Response](https://lifeattiktok.com/search/7663032057264244997) — Seattle, WA · posted 2026-08-03 · SWE · BS
- [Backend Software Engineer - Machine Moderation Platform](https://lifeattiktok.com/search/7663036950303050037) — Seattle, WA · posted 2026-08-03 · SWE · BS
- [Backend Software Engineer Graduate - Business Governance](https://lifeattiktok.com/search/7663042453461600517) — San Jose, CA · posted 2026-08-03 · SWE · BS
- [Backend Software Engineer New Grad - Feed Safety](https://lifeattiktok.com/search/7663028952600807733) — Seattle, WA · posted 2026-08-03 · SWE · BS/MS/PhD
- [Backend Software Engineer New Grad - Emerging Products & AI Safety](https://lifeattiktok.com/search/7663036952090347829) — San Jose, CA · posted 2026-08-03 · SWE · BS/MS
- [Backend Software Engineer New Grad - Trust & Safety](https://lifeattiktok.com/search/7664533229944178949) · [2](https://lifeattiktok.com/search/7665994926887291189) — Seattle, WA; San Jose, CA · posted 2026-08-03 · SWE · BS/MS/PhD
- [Machine Learning Engineer Graduate](https://lifeattiktok.com/search/7665797203155896581) · [2](https://lifeattiktok.com/search/7667344113001384197) · [3](https://lifeattiktok.com/search/7667346543553710389) — San Jose, CA · posted 2026-08-03 · ML · BS/MS
- [Machine Learning Engineer New Grad - Data Search Visual Search](https://lifeattiktok.com/search/7667349591747758341) — San Jose, CA · posted 2026-08-03 · ML · BS/MS
- [Machine Learning Engineer New Grad](https://lifeattiktok.com/search/7668376903708281141) — Seattle, WA · posted 2026-08-03 · ML · BS/MS
- [Machine Learning Engineer New Grad - E-Commerce Search](https://lifeattiktok.com/search/7668390999147776309) — Seattle, WA · posted 2026-08-03 · ML · BS/MS
- [Machine Learning Engineer Graduate - Ads Delivery](https://lifeattiktok.com/search/7668660365135808821) — San Jose, CA · posted 2026-08-03 · ML · BS/MS
- [Machine Learning Engineer Graduate - Monetization Technology - Ads Core Global](https://lifeattiktok.com/search/7668592348941273349) — San Jose, CA · posted 2026-08-03 · ML · BS/MS
- [Software Engineer New Grad - Business Integrity](https://lifeattiktok.com/search/7668592494649690421) — San Jose, CA · posted 2026-08-03 · SWE · BS/MS
- [Machine Learning Engineer Graduate - Ads Creative](https://lifeattiktok.com/search/7668669015051405573) — San Jose, CA · posted 2026-08-03 · ML · MS
- [Machine Learning Engineer Graduate - Ads Targeting](https://lifeattiktok.com/search/7668629846058223877) — San Jose, CA · posted 2026-08-03 · ML · BS/MS
- [Machine Learning Infrastructure Engineer New Grad - Ads Infra](https://lifeattiktok.com/search/7668693662561634613) — San Jose, CA · posted 2026-08-03 · ML · BS/MS
- [Software Engineer Graduate - Ads Delivery](https://lifeattiktok.com/search/7668662545059023157) — San Jose, CA · posted 2026-08-03 · SWE · BS/MS
- [Software Engineer Graduate - MLOps](https://lifeattiktok.com/search/7668700671828707589) — San Jose, CA · posted 2026-08-03 · SWE · BS/MS
- [Software Engineer/Mobile Engineer New Grad - Ads Core Demonstration](https://lifeattiktok.com/search/7668701834807101749) — San Jose, CA · posted 2026-08-03 · SWE · BS/MS
- [Software Engineer New Grad - Ads Measurement Signal Technology](https://lifeattiktok.com/search/7668717356843977013) — San Jose, CA · posted 2026-08-03 · SWE · BS/MS
- [Software Engineer New Grad - Ads Signal & Measurement](https://lifeattiktok.com/search/7668724383120804149) — San Jose, CA · posted 2026-08-03 · SWE · BS/MS

</details>
<details>
<summary>ByteDance (36)</summary>

- [Machine Learning Engineer Graduate - E-Commerce Risk Control](https://jobs.bytedance.com/en/position/7675477660855781637/detail) · [2](https://jobs.bytedance.com/en/position/7675477254315428149/detail) — San Jose, CA; Seattle, WA · posted 2026-08-19 · ML · BS/MS
- [Multi-Cloud CDN Data Platform Engineer Graduate - CDN Platform](https://jobs.bytedance.com/en/position/7673632479987992837/detail) · [2](https://jobs.bytedance.com/en/position/7673630747427719429/detail) · [3](https://jobs.bytedance.com/en/position/7670355647603984693/detail) — San Jose, CA; Seattle, WA · posted 2026-08-19 · ML · BS/MS
- [Multi-Cloud CDN Scheduling Platform Engineer Graduate - CDN Platform](https://jobs.bytedance.com/en/position/7673626856724023557/detail) — Seattle, WA · posted 2026-08-14 · SWE · MS
- [Multi-Cloud CDN Platform Engineer Graduate - CDN Platform](https://jobs.bytedance.com/en/position/7670355132899526965/detail) — Seattle, WA · posted 2026-08-14 · SWE · BS
- [Research Scientist Graduate - Seed AI Foundation Model Infrastructure](https://jobs.bytedance.com/en/position/7673268418623293749/detail) — San Jose, CA · posted 2026-08-13 · ML · BS
- [Agent Evaluation and Evolution Machine Learning Engineer Graduate - Applied Machine Learning Ark](https://jobs.bytedance.com/en/position/7672391016194066693/detail) — Seattle, WA · posted 2026-08-11 · ML · BS/MS
- [Data Lake Infrastructure & Data Analytics Research Engineer Graduate - AML-ARK](https://jobs.bytedance.com/en/position/7672395094280063285/detail) — Seattle, WA · posted 2026-08-11 · ML · BS/MS
- [Visual Generation & Multimodal Evaluation Machine Learning Engineer Graduate](https://jobs.bytedance.com/en/position/7672392998189959429/detail) — Seattle, WA · posted 2026-08-11 · ML · BS/MS
- [Visual Generation & Multimodal Evaluation Machine Learning Engineer Graduate - Applied Machine Learning Ark](https://jobs.bytedance.com/en/position/7671102043532462389/detail) — San Jose, CA · posted 2026-08-10 · ML · BS/MS
- [Data Lake Infrastructure & Data Analytics Research Engineer Graduate - Applied Machine Learning Ark](https://jobs.bytedance.com/en/position/7671107540954777861/detail) — San Jose, CA · posted 2026-08-10 · ML · BS/MS
- [Software Development Engineer Graduate - Intent-Based Networking](https://jobs.bytedance.com/en/position/7671145911004842245/detail) — San Jose, CA · posted 2026-08-07 · SWE · BS/MS
- [Large Language Model Inference System Engineer New Grad - Applied Machine Learning](https://jobs.bytedance.com/en/position/7667726338627356933/detail) — San Jose, CA · posted 2026-08-07 · ML · BS/MS
- [LLM Backend Engineer Graduate - Applied Machine Learning](https://jobs.bytedance.com/en/position/7667730992538585349/detail) — San Jose, CA · posted 2026-08-07 · ML · BS/MS
- [Machine Learning Engineer Graduate - Agent Evaluation & Evolution](https://jobs.bytedance.com/en/position/7670932427485186309/detail) — San Jose, CA · posted 2026-08-07 · ML · BS/MS
- [Research Scientist Graduate - ML Recommendation Systems](https://jobs.bytedance.com/en/position/7670850283815160069/detail) — San Jose, CA · posted 2026-08-07 · ML · BS/MS
- [LLM/AI Operations Development Engineer Graduate - Data Center Networking](https://jobs.bytedance.com/en/position/7670773781477394741/detail) — San Jose, CA · posted 2026-08-07 · ML · BS/MS
- [Backend Inference Runtime Engineer New Grad - AML Inference](https://jobs.bytedance.com/en/position/7669789046777940229/detail) — San Jose, CA · posted 2026-08-06 · SWE · BS/MS
- [Machine Learning Backend Engineer Graduate - AML MLDev](https://jobs.bytedance.com/en/position/7669791940490168629/detail) — San Jose, CA · posted 2026-08-06 · ML · BS/MS
- [Backend Inference Framework Engineer - AML Inference](https://jobs.bytedance.com/en/position/7669670735275526453/detail) — San Jose, CA · posted 2026-08-06 · SWE · BS/MS
- [Graduate Software Engineer - Data-Intelligent Creation-AI Platform-Global Vision Engineering](https://jobs.bytedance.com/en/position/7669859743775000885/detail) — San Jose, CA · posted 2026-08-06 · SWE · BS/MS
- [Operating System Engineer Graduate - Operating System-System Technologies and Engineering](https://jobs.bytedance.com/en/position/7668461589331642677/detail) — San Jose, CA · posted 2026-08-06 · SWE · BS
- [Backend Development Engineer Graduate - Infrastructure Platform Delivery](https://jobs.bytedance.com/en/position/7668484998475663621/detail) — San Jose, CA · posted 2026-08-06 · SWE · BS/MS
- [Graduate AI Model Optimization Engineer - Data Speech Product R&D Engineering](https://jobs.bytedance.com/en/position/7669899962768165173/detail) — San Jose, CA · posted 2026-08-05 · SWE · BS/MS
- [3D Graphics Innovation Engineer - PICO Foundation-Developer Technology](https://jobs.bytedance.com/en/position/7667926830305528117/detail) — San Jose, CA · posted 2026-08-04 · SWE · BS/MS
- [Software Engineer New Grad - AI Infrastructure-Compute Efficiency & Scheduling](https://jobs.bytedance.com/en/position/7668799020705679669/detail) — Seattle, WA · posted 2026-08-03 · SWE · BS/MS
- [Test Software Engineer Graduate - Research and Development Middle Platform](https://jobs.bytedance.com/en/position/7664894974764828981/detail) — San Jose, CA · posted 2026-08-03 · SWE · BS/MS
- [Backend Software Engineer Graduate - Platform](https://jobs.bytedance.com/en/position/7667269919588321541/detail) · [2](https://jobs.bytedance.com/en/position/7667267464923171077/detail) — San Jose, CA; NYC · posted 2026-08-03 · SWE · BS/MS
- [Software Engineer Graduate - AI Infrastructure Compute](https://jobs.bytedance.com/en/position/7667334059728341253/detail) — San Jose, CA · posted 2026-08-03 · SWE · MS
- [Software Engineer New Grad - AI Infra Compute](https://jobs.bytedance.com/en/position/7667303429264115973/detail) — Seattle, WA · posted 2026-08-03 · SWE · MS
- [Artificial Intelligence Software Engineer - Development Infrastructure](https://jobs.bytedance.com/en/position/7667901772678302005/detail) — San Jose, CA · posted 2026-08-03 · SWE · BS/MS
- [Backend and Infrastructure Software Engineer New Grad - Dev Infra](https://jobs.bytedance.com/en/position/7667894766036322565/detail) — San Jose, CA · posted 2026-08-03 · SWE · BS/MS
- [Software Engineer AI Agent Infrastructure - Security Engineering](https://jobs.bytedance.com/en/position/7667976924430633269/detail) — San Jose, CA · posted 2026-08-03 · SWE · BS/MS

</details>
<details open>
<summary>Palantir (10)</summary>

- [Software Engineer New Grad - Defense](https://jobs.lever.co/palantir/18d901fc-93bb-4d18-9f04-c72031e20d79/apply) · [2](https://jobs.lever.co/palantir/f362d7aa-360d-4059-ab38-f482742693b3/apply) · [3](https://jobs.lever.co/palantir/0a838e66-1ab0-4fc4-b4d3-4671c0352278/apply) — Washington, DC; Palo Alto, CA; NYC · posted 2026-06-29 · SWE
- [Forward Deployed Software Engineer New Grad - Commercial](https://jobs.lever.co/palantir/e500bcf3-19d8-4d3c-b340-4d76e4a55b40/apply) · [2](https://jobs.lever.co/palantir/2e6b0ac8-83e9-4be5-a3aa-cf319f751728/apply) — Chicago, IL; NYC · posted 2026-06-29 · SWE · BS
- [Software Engineer New Grad](https://jobs.lever.co/palantir/c34b424e-caf2-455a-b104-ae1096ccca29/apply) — Denver, CO · posted 2026-06-29 · SWE · BS
- [Privacy & Civil Liberties Engineer New Grad](https://jobs.lever.co/palantir/95e0d2b0-437a-4096-a5c6-0f247f426c90/apply) — NYC · posted 2026-06-26 · SWE · BS
- [Forward Deployed Software Engineer New Grad](https://jobs.lever.co/palantir/cbe90327-3e6e-451c-a54c-1d3cbcef5aeb/apply) · [2](https://jobs.lever.co/palantir/d1ac83d0-e923-42a5-8e6d-58dd0cab25ca/apply) · [3](https://jobs.lever.co/palantir/fbca0358-083a-4222-bdbb-3bd729b48382/apply) — Washington, DC; NYC · posted 2026-06-16 · SWE

</details>
<details open>
<summary>Apple (9)</summary>

- [Firmware Engineer - HID Bluetooth](https://jobs.apple.com/en-us/details/200684986) — Cupertino, CA · posted 2026-09-22 · HW · BS
- [Systems Software Engineer](https://jobs.apple.com/en-us/details/200683808) — San Diego, CA · posted 2026-09-15 · SWE · BS
- [Cellular Layer-1 Control Software Development Engineer - Wireless Technologies & Ecosystems](https://jobs.apple.com/en-us/details/200681316) — Sunnyvale, CA · posted 2026-09-01 · HW · BS/MS
- [CAD Automation and Mixed-Signal Simulation Engineer](https://jobs.apple.com/en-us/details/200680375) — Sunnyvale, CA · posted 2026-08-27 · SWE · BS
- [Systems Engineer - UI Compositing](https://jobs.apple.com/en-us/details/200680183) — Cupertino, CA · posted 2026-08-26 · SWE · BS/MS
- [Darwin Runtime Engineer - Core OS](https://jobs.apple.com/en-us/details/200662330) — Cupertino, CA · posted 2026-08-20 · SWE · BS/MS
- [Frontend Engineer](https://jobs.apple.com/en-us/details/200676168) — Austin, TX · posted 2026-08-10 · SWE · BS
- [Cellular Power Optimization Software Engineer - Wireless Technologies & Ecosystems](https://jobs.apple.com/en-us/details/200657382) — San Diego, CA · posted 2026-07-31 · HW · BS/MS
- [Software Engineer Silicon Engineering Documentation Tools](https://jobs.apple.com/en-us/details/200661584) — Lafayette, KS · posted 2026-05-06 · SWE

</details>
<details open>
<summary>Amazon (7)</summary>

- [Software Privacy Engineer - Multiple Teams](https://amazon.jobs/en/jobs/10538147/software-privacy-engineer-trust-platform-automation-devices-services-trust-privacy-and-accessibility-tpa) — Bellevue, WA · posted 2026-09-12 · SWE · BS
- [Applied Scientist - Global Risk Intelligence and Prevention - Seller Abuse Prevention](https://amazon.jobs/en/jobs/10528088/applied-scientist-global-risk-intelligence-and-prevention-seller-abuse-prevention) — Seattle, WA · posted 2026-09-03 · ML · MS/PhD
- [Robotics System Development Engineer](https://amazon.jobs/en/jobs/10523031/robotics-system-development-engineer) — Austin, TX · posted 2026-09-01 · SWE · BS
- [Software Development Engineer - Amazon Leo](https://amazon.jobs/en/jobs/10513110/software-development-engineer-amazon-leo-early-career-2026) — Redmond, WA, Northridge, LA · posted 2026-08-25 · SWE · BS/MS
- [EFA Network Software Engineer 1 - Annapurna Labs](https://amazon.jobs/en/jobs/10481932/efa-network-software-engineer-i-annapurna-labs) — Seattle, WA · posted 2026-07-22 · SWE · BS/MS
- [Software Development Engineer - Military Veterans](https://amazon.jobs/en/jobs/3179205/software-development-engineer-military-veterans) — Seattle, WA, Redmond, WA, Arlington, VA · posted 2026-07-14 · SWE · BS
- [Software Development Engineer](https://amazon.jobs/en/jobs/3177934/software-development-engineer-2026-us) — Seattle, WA · posted 2026-05-04 · SWE · BS

</details>
<details open>
<summary>Anduril (7)</summary>

- [Early Career Firmware Engineer](https://boards.greenhouse.io/andurilindustries/jobs/5246141007) — Costa Mesa, CA · posted 2026-09-22 · HW · BS/MS
- [Software Engineer - Battlespace Awareness](https://boards.greenhouse.io/andurilindustries/jobs/5240165007) — Fort Collins, CO, Broomfield, CO · posted 2026-09-16 · SWE · BS
- [Firmware Engineer - Space - Emerging Talent](https://boards.greenhouse.io/andurilindustries/jobs/5239596007) — Costa Mesa, CA · posted 2026-09-16 · HW · BS/MS
- [Early Career Flight Software Engineer](https://boards.greenhouse.io/andurilindustries/jobs/5228868007) — Costa Mesa, CA · posted 2026-09-03 · HW · BS/MS
- [Agentic AI Engineer - Automation](https://boards.greenhouse.io/andurilindustries/jobs/5219383007) — Costa Mesa, CA · posted 2026-08-26 · SWE · MS/PhD
- [Software Engineer - Tracking](https://boards.greenhouse.io/andurilindustries/jobs/5215629007) — Fort Collins, CO, Broomfield, CO · posted 2026-08-19 · SWE · BS
- [Software Engineer](https://boards.greenhouse.io/andurilindustries/jobs/5162263007) — Boston, MA, Seattle, WA, Newport Beach, CA · posted 2026-06-11 · SWE · BS/MS

</details>
<details open>
<summary>Old Mission (6)</summary>

- [Floor Trader New Grad](https://www.oldmissioncapital.com/careers/?gh_jid=7993756003) — Chicago, IL · posted 2026-09-16 · Quant · BS
- [Software Engineer – Graduate Program - August Start](https://www.oldmissioncapital.com/careers/?gh_jid=7796048003) — Chicago, IL · posted 2026-07-13 · SWE · BS
- [Quantitative Trader](https://www.oldmissioncapital.com/careers/?gh_jid=7796031003) — Chicago, IL, NYC · posted 2026-07-13 · Quant · BS
- [Quantitative Trader Graduate Program](https://www.oldmissioncapital.com/careers/?gh_jid=7796044003) — Chicago, IL, NYC · posted 2026-07-13 · Quant · BS
- [Quantitative Trader – Graduate Program - August Start](https://www.oldmissioncapital.com/careers/?gh_jid=7796058003) — London, UK, Chicago, IL, NYC · posted 2026-07-13 · Quant · BS/MS
- [Junior Quantitative Researcher](https://www.oldmissioncapital.com/careers/?gh_jid=6309652003) — Chicago, IL · posted 2026-05-18 · Quant · MS/PhD

</details>
<details open>
<summary>Akuna Capital University (5)</summary>

- [Entry Level Software Engineer - C++](https://www.akunacapital.com/careers/job/8013085/?gh_jid=8013085) — Chicago, IL · posted 2026-07-13 · SWE · BS/MS/PhD
- [Junior Trader](https://www.akunacapital.com/careers/job/7773141/?gh_jid=7773141) — Chicago, IL · posted 2026-07-13 · Quant · BS/MS/PhD
- [Junior Quantitative Researcher](https://www.akunacapital.com/careers/job/8036541/?gh_jid=8036541) — Chicago, IL · posted 2026-07-13 · Quant · BS/MS/PhD
- [Junior Quantitative Developer & Strategist](https://www.akunacapital.com/careers/job/8016687/?gh_jid=8016687) — Chicago, IL · posted 2026-07-13 · Quant · BS/MS/PhD
- [Software Engineer - Python](https://www.akunacapital.com/careers/job/8013230/?gh_jid=8013230) — Chicago, IL · posted 2026-07-13 · SWE · BS/MS/PhD

</details>
<details open>
<summary>Applied Intuition (5)</summary>

- [Forward Deployed Engineer New Grad](https://jobs.ashbyhq.com/applied/31140958-d768-452c-8498-0b1c7f403943/application?embed=true) — Sunnyvale, CA · posted 2026-09-03 · SWE · BS/MS
- [Research Engineer New Grad](https://jobs.ashbyhq.com/applied/45fc41cd-8280-4010-ba1f-def6114b3e39/application?embed=true) — Sunnyvale, CA · posted 2026-08-15 · ML · MS/PhD
- [Software Engineer New Grad - December 2026](https://jobs.ashbyhq.com/applied/a837cbd6-9fe4-4d74-a2dc-84f602c40694/application?embed=true) — Ann Arbor, MI, Sunnyvale, CA · posted 2026-08-15 · SWE · BS/MS
- [Software Integration Engineer New Grad](https://jobs.ashbyhq.com/applied/250080bd-10a8-4e5f-82b8-506029292d19/application?embed=true) — Sunnyvale, CA · posted 2026-08-15 · HW · BS/MS
- [Embedded Software Engineer New Grad](https://jobs.ashbyhq.com/applied/6971d533-1536-448b-96b8-544ad5383f44/application?embed=true) — Sunnyvale, CA · posted 2026-08-15 · HW · BS/MS/PhD

</details>
<details open>
<summary>Cerebras (5)</summary>

- [Software Engineer - Kernel Reliability](https://jobs.ashbyhq.com/cerebras/8cb78937-ac30-4ab2-98d0-680228ea5e6f/application?embed=true) — Canada, United States · posted 2026-09-15 · SWE
- [Kernel Engineer New Grad](https://jobs.ashbyhq.com/cerebras/9c7da4b8-446b-4bf2-8d07-23241590bf2e/application?embed=true) — Canada, United States · posted 2026-07-23 · SWE · BS/MS/PhD
- [Software Engineer New Grad](https://jobs.ashbyhq.com/cerebras/99c289fa-8fc6-49f7-b7e8-78ac4e9d99ac/application) · [2](https://jobs.ashbyhq.com/cerebras/987d7f64-c957-4c8f-b89d-2f9d64738507/application) — Toronto, ON, Canada, Sunnyvale, CA; Sunnyvale, CA · posted 2026-07-07 · SWE · BS/MS
- [Software Integration Engineer - AI Inference Core](https://jobs.ashbyhq.com/cerebras/90879967-1071-4d05-9180-6e18023ed887/application?embed=true) — Toronto, ON, Canada, Sunnyvale, CA · posted 2026-07-07 · SWE

</details>
<details open>
<summary>Chicago Trading Company (4)</summary>

- [Associate Engineer](https://job-boards.greenhouse.io/chicagotradingcampus/jobs/4716937005) · [2](https://job-boards.greenhouse.io/ctccampusboard/jobs/4709991005) — Chicago, IL, NYC · posted 2026-08-03 · SWE · BS/MS
- [Quant Trading Associate](https://job-boards.greenhouse.io/chicagotradingcampus/jobs/4716507005) — Chicago, IL · posted 2026-08-03 · Quant · BS/MS
- [Quantitative Trading Associate](https://job-boards.greenhouse.io/ctccampusboard/jobs/4708724005) — Chicago, IL · posted 2026-07-31 · Quant · BS/MS

</details>
<details open>
<summary>Citadel (4)</summary>

- [Sector Data Scientist - Central Team](https://www.citadel.com/careers/details/sector-data-scientist-central-team/) — NYC · posted 2026-07-27 · ML · BS/MS
- [Quantitative Trader: Equity Quantitative Research – University Graduate](https://www.citadel.com/careers/details/quantitative-trader-equity-quantitative-research-university-graduate-us/) — NYC · posted 2026-07-07 · Quant · BS
- [Quantitative Research Analyst University Graduate](https://www.citadel.com/careers/details/quantitative-research-analyst-university-graduate-us/) — Greenwich, CT, Miami, FL, NYC · posted 2026-07-06 · Quant · BS/MS
- [Software Engineer – University Graduate](https://www.citadel.com/careers/details/software-engineer-university-graduate-us/) — Greenwich, CT, Houston, TX, Miami, FL · posted 2026-07-06 · SWE

</details>
<details open>
<summary>Citadel Securities (4)</summary>

- [Quantitative AI Technical Staff](https://www.citadelsecurities.com/careers/details/quantitative-ai-technical-staff/) — Miami, FL · posted 2026-07-22 · ML · BS/MS/PhD
- [Graduate Software Engineer](https://www.citadelsecurities.com/careers/details/software-engineer-university-graduate-us/) — Miami, FL, NYC · posted 2026-07-06 · SWE · BS/MS/PhD
- [Quantitative Trader – University Graduate](https://www.citadelsecurities.com/careers/details/quantitative-trader-university-graduate-us-miami/) · [2](https://www.citadelsecurities.com/careers/details/quantitative-trader-university-graduate-us-new-york/) — Miami, FL; NYC · posted 2026-07-06 · Quant · BS/MS/PhD

</details>
<details open>
<summary>IMC Trading (4)</summary>

- [Performance Engineer](https://job-boards.eu.greenhouse.io/imc/jobs/4823836101) — Chicago, IL · posted 2026-08-27 · SWE · BS
- [Graduate Software Engineer](https://job-boards.eu.greenhouse.io/imc/jobs/4818790101) — Chicago, IL · posted 2026-07-01 · SWE · BS
- [Graduate Quantitative Researcher](https://job-boards.eu.greenhouse.io/imc/jobs/4907368101) — Chicago, IL · posted 2026-07-01 · Quant · BS/MS
- [Graduate Quantitative Trader](https://job-boards.eu.greenhouse.io/imc/jobs/4751729101) — Chicago, IL · posted 2026-07-01 · Quant · BS

</details>
<details open>
<summary>Susquehanna International Group (SIG) (4)</summary>

- [Quantitative Researcher](https://careers-sig.icims.com/jobs/11016/job?mobile=true&needsRedirect=false) · [2](https://careers-sig.icims.com/jobs/11018/job?mobile=true&needsRedirect=false) — Ardmore, PA; Philadelphia, PA, NYC · posted 2026-06-29 · Quant · MS
- [Quantitative Systematic Trader](https://careers-sig.icims.com/jobs/11022/job?mobile=true&needsRedirect=false) · [2](https://careers-sig.icims.com/jobs/11020/job?mobile=true&needsRedirect=false) — Philadelphia, PA, NYC; Ardmore, PA · posted 2026-06-29 · Quant · MS

</details>
<details open>
<summary>Tesla (4)</summary>

- [Data Statistician](https://www.tesla.com/careers/search/job/282286) — Fremont, CA · posted 2026-09-09 · ML · BS
- [Data Analytics Engineer Scientist - Thermal - Chassis](https://www.tesla.com/careers/search/job/262399) — Palo Alto, CA · posted 2026-07-13 · ML · BS
- [AI Engineer - Whole Body Controls - Optimus](https://www.tesla.com/careers/search/job/275999) — Palo Alto, CA · posted 2026-07-06 · ML
- [Applied Reinforcement Learning Engineer - Whole Body Controls - Optimus](https://www.tesla.com/careers/search/job/276000) — Palo Alto, CA · posted 2026-07-06 · ML

</details>
<details open>
<summary>Two Sigma (4)</summary>

- [Software Engineer](https://twosigma.avature.net/careers/JobDetail/14018) · [2](https://twosigma.avature.net/careers/JobDetail/14014) — Houston, TX; NYC · posted 2026-09-08 · SWE · BS/MS/PhD
- [Quantitative Researcher - Full-Time Campus Hire](https://twosigma.avature.net/careers/JobDetail/13946) — NYC · posted 2026-08-02 · Quant · BS/MS/PhD
- [AI Research Scientist - Campus Full-Time](https://twosigma.avature.net/careers/JobDetail/13671) — NYC · posted 2026-08-02 · ML · MS/PhD

</details>
<details open>
<summary>DRW (3)</summary>

- [Floor Trader](https://job-boards.greenhouse.io/drweng/jobs/8207750) — Chicago, IL · posted 2026-09-16 · Quant · BS
- [Software Developer](https://job-boards.greenhouse.io/drweng/jobs/7980165) — Chicago, IL · posted 2026-07-13 · SWE · BS/MS/PhD
- [Quantitative Researcher](https://job-boards.greenhouse.io/drweng/jobs/8030406) — Chicago, IL, NYC · posted 2026-07-13 · Quant · BS/MS/PhD

</details>
<details open>
<summary>Optiver (3)</summary>

- [Equity Analyst New Grad](https://www.optiver.com/join-us/jobs/8616003002/?gh_jid=8616003002) — Chicago, IL · posted 2026-07-21 · Quant · BS/MS
- [Graduate Software Engineer](https://www.optiver.com/join-us/jobs/8401042002/?gh_jid=8401042002) · [2](https://www.optiver.com/join-us/jobs/8604899002/?gh_jid=8604899002) — Chicago, IL; Austin, TX · posted 2026-07-01 · SWE · BS/MS/PhD

</details>
<details open>
<summary>Wolverine Trading (3)</summary>

- [Entry Level C++ Software Engineer](https://wolve.pinpointhq.com/en/postings/2b2e514b-4709-4897-960d-77909fe33ab8?ats=pinpointhq) · [2](https://wolve.pinpointhq.com/en/postings/1f33c89b-2592-498d-b45a-1b2092cf944e?ats=pinpointhq) · [3](https://wolve.pinpointhq.com/en/postings/e03d9864-a128-40ff-91b5-dfc9fd1b59d6?ats=pinpointhq) — Chicago, IL · posted 2026-09-18 · SWE · BS/MS

</details>
<details open>
<summary>Belvedere Trading (2)</summary>

- [Quantitative Trader](https://jobs.lever.co/belvederetrading/34369a5c-55c0-4e9f-9d2e-4f21b9418bee/apply) — Chicago, IL · posted 2026-08-07 · Quant
- [Software Engineer](https://jobs.lever.co/belvederetrading/2f6480e5-7bf1-4c41-b3b5-3c7404d95b5f/apply) — Chicago, IL · posted 2026-08-07 · SWE

</details>
<details open>
<summary>Five Rings Capital (2)</summary>

- [Campus Full Time - Software Developer](https://job-boards.greenhouse.io/fiveringsllc/jobs/5349839008) — NYC · posted 2026-07-14 · SWE
- [Quantitative Trader - Quantitative Trader](https://job-boards.greenhouse.io/fiveringsllc/jobs/5255334008) — NYC · posted 2026-07-14 · Quant

</details>
<details open>
<summary>Headlands Tech Holdings (2)</summary>

- [C++ Software Developer New Grad](https://job-boards.greenhouse.io/headlandstechnologiesllc/jobs/4336806009) — Chicago, IL · posted 2026-09-16 · SWE · BS
- [Research Developer New Grad](https://job-boards.greenhouse.io/headlandstechnologiesllc/jobs/4227566009) — London, UK, Chicago, IL, NYC · posted 2026-07-05 · ML · BS

</details>
<details open>
<summary>Hudson River Trading (2)</summary>

- [Software Engineer - C++ or Python](https://www.hudsonrivertrading.com/careers/job/?gh_jid=8052122) — Austin, TX, Chicago, IL, NYC · posted 2026-07-13 · SWE · BS/MS
- [Algorithm Developer New Grad - Quant Researcher](https://www.hudsonrivertrading.com/careers/job/?gh_jid=8052050) — NYC · posted 2026-07-13 · Quant · BS/MS

</details>
<details open>
<summary>Marshall Wace (2)</summary>

- [Quant Research - Quantitative Associate Programme](https://job-boards.greenhouse.io/mw-tech-grad/jobs/8636830002) — London, UK, NYC · posted 2026-08-26 · Quant
- [Software/Infrastructure Graduate](https://job-boards.greenhouse.io/mw-tech-grad/jobs/8646937002) — NYC · posted 2026-07-31 · SWE

</details>
<details open>
<summary>Microsoft (2)</summary>

- [Software Engineer - Cleared](https://apply.careers.microsoft.com/careers/job/1970393556982911) — Reston, VA · posted 2026-09-23 · SWE · BS/MS
- [Software Engineer - Ctj - Poly](https://apply.careers.microsoft.com/careers/job/1970393556860973) — Annapolis Junction, MD, Reston, VA · posted 2026-06-18 · SWE · BS

</details>
<details open>
<summary>NVIDIA (2)</summary>

- [Architecture Energy Modeling Engineer - Power Modeling, Methodology and Analysis](https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Architecture-Energy-Modeling-Engineer---New-College-Grad-2026_JR2023398) — Santa Clara, CA · posted 2026-08-21 · ML · MS/PhD
- [Software Engineer New Grad - Hardware Tools and Methodology](https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Software-Engineer--Hardware-Tools-and-Methodology---New-College-Grad-2026_JR2018659) — Santa Clara, CA · posted 2026-06-03 · SWE · MS/PhD

</details>
<details open>
<summary>Salesforce (2)</summary>

- [AI Builder - Emerging Talent](https://salesforce.wd12.myworkdayjobs.com/Futureforce_NewGradRoles/job/California---San-Francisco/AI-Builder--Emerging-Talent_JR357678) · [2](https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/California---San-Francisco/AI-Builder--Emerging-Talent_JR357678-1) — SF, McLean, VA, Chicago, IL · posted 2026-08-26 · SWE

</details>
<details open>
<summary>Scale AI (2)</summary>

- [Software Engineer New Grad - Public Sector](https://job-boards.greenhouse.io/scaleai/jobs/4736426005) — SF · posted 2026-09-23 · SWE · BS
- [Software Engineer New Grad](https://job-boards.greenhouse.io/scaleai/jobs/4730836005) — SF · posted 2026-09-04 · SWE · BS

</details>
<details open>
<summary>ServiceNow (2)</summary>

- [Software Engineer](https://jobs.smartrecruiters.com/ServiceNow/744000149338366) — West Palm Beach, FL · posted 2026-09-14 · SWE
- [Associate Applications Development Engineer](https://jobs.smartrecruiters.com/ServiceNow/744000144653619) — Santa Clara, CA · posted 2026-08-21 · SWE · BS

</details>
<details open>
<summary>Stripe (2)</summary>

- [Software Engineer - Early Career - Immediate Start](https://stripe.com/jobs/search?gh_jid=8212508) — Seattle, WA, SF, NYC · posted 2026-09-18 · SWE · BS/MS
- [Software Engineer New Grad](https://stripe.com/jobs/search?gh_jid=8128744) — Seattle, WA, SF, NYC · posted 2026-09-01 · SWE · BS/MS

</details>
<details open>
<summary>Susquehanna International Group (2)</summary>

- [Trading System Engineer New Grad](https://careers-sig.icims.com/jobs/11349/job?mobile=true&needsRedirect=false) — Bala Cynwyd, PA · posted 2026-08-21 · Quant · BS/MS
- [Quantitative Strategy Developer New Grad](https://careers-sig.icims.com/jobs/11321/job?mobile=true&needsRedirect=false) — Bala Cynwyd, PA · posted 2026-08-19 · Quant · BS/MS

</details>
<details open>
<summary>Tower Research Capital (2)</summary>

- [Data Analyst - Data](https://www.tower-research.com/open-positions/?gh_jid=8167234) — NYC · posted 2026-09-16 · ML · MS/PhD
- [Quantitative Trader](https://www.tower-research.com/open-positions/?gh_jid=8024142) — Chicago, IL, NYC · posted 2026-07-05 · Quant · BS/MS/PhD

</details>
<details open>
<summary>Wintermute (2)</summary>

- [Algorithmic Trader](https://jobs.lever.co/wintermute-trading/28c7e15f-b3a0-48c6-8322-2e9f25371fd0/apply) — London, UK, NYC · posted 2026-09-03 · Quant
- [Graduate Algorithmic Trader](https://jobs.lever.co/wintermute-trading/d962dc39-8839-4e13-a37a-baba49e52b44/apply) — NYC · posted 2026-09-01 · Quant

</details>
<details open>
<summary>xAI (2)</summary>

- [Software Engineer - Evals](https://job-boards.greenhouse.io/xai/jobs/5188230007) — Palo Alto, CA · posted 2026-07-22 · SWE
- [Software Engineer - Ads Product](https://job-boards.greenhouse.io/xai/jobs/5152408007) — Palo Alto, CA · posted 2026-06-02 · SWE

</details>
<details open>
<summary>Adobe (1)</summary>

- [Applied Scientist](https://adobe.wd5.myworkdayjobs.com/external_experienced/job/San-Jose/Senior-Applied-Scientist_R165817) — San Jose, CA · posted 2026-09-04 · ML · MS/PhD

</details>
<details open>
<summary>Anysphere (1)</summary>

- [Software Engineer New Grad - 2027](https://jobs.ashbyhq.com/cursor/d0e5b41d-84ab-4887-bd3a-55589b11dd7b/application?embed=true) — SF, NYC · posted 2026-09-10 · SWE · BS

</details>
<details open>
<summary>AQR Capital Management (1)</summary>

- [Trading Analyst](https://careers.aqr.com/jobs?gh_jid=8156709&gh_jid=8156709) — Greenwich, CT · posted 2026-08-25 · Quant · BS/MS

</details>
<details open>
<summary>Atlassian (1)</summary>

- [Software Engineer](https://campus-americas.icims.com/jobs/25813/software-engineer%2c-2027-graduate-u.s./job) — Seattle, WA · posted 2026-09-15 · SWE · BS/MS

</details>
<details open>
<summary>DoorDash (1)</summary>

- [Software Engineer 1 - Entry-Level](https://job-boards.greenhouse.io/doordashusa/jobs/8163709) — Seattle, WA, SF, LA · posted 2026-09-04 · SWE · BS/MS

</details>
<details open>
<summary>Figma (1)</summary>

- [Data Scientist, Core Data](https://job-boards.greenhouse.io/figma/jobs/5976930004?gh_jid=5976930004) — New York, NY, San Francisco, CA · posted 2026-05-01 · ML · MS

</details>
<details open>
<summary>Flow Traders (1)</summary>

- [Graduate Quantitative Trader](https://job-boards.greenhouse.io/flowtraders/jobs/8094581) — NYC · posted 2026-07-29 · Quant · BS

</details>
<details open>
<summary>Google (1)</summary>

- [Software Engineer - Campus](https://www.google.com/about/careers/applications/jobs/results/78703249065943750) — Cambridge, MA, Seattle, WA, LA · posted 2026-08-07 · SWE · BS/MS

</details>
<details open>
<summary>Jump Trading (1)</summary>

- [AI Research Engineer](https://boards.greenhouse.io/embed/job_app?token=8052313) — Chicago, IL, NYC · posted 2026-07-08 · ML

</details>
<details open>
<summary>Man Group (1)</summary>

- [Risk & Performance Analyst](https://job-boards.eu.greenhouse.io/mangroup/jobs/4958874101) — Boston, MA · posted 2026-08-27 · ML

</details>
<details open>
<summary>Motional (1)</summary>

- [Motion Planning Engineer - Trajectory Generation](https://motional.com/open-positions/?gh_jid=7980363003#/7980363003) — Boston, MA, Las Vegas, NV, Remote in USA · posted 2026-09-14 · ML · BS/MS/PhD

</details>
<details open>
<summary>OpenAI (1)</summary>

- [Software Engineer - Applied Emerging Talent](https://jobs.ashbyhq.com/openai/55150071-fce8-48f5-aea4-14ed78b83511/application?embed=true) — SF · posted 2026-09-15 · SWE · BS/MS

</details>
<details open>
<summary>Point72 (1)</summary>

- [Software Developer - Developers](https://boards.greenhouse.io/point72/jobs/7598678002) — NYC · posted 2026-08-19 · Quant · BS/MS

</details>
<details open>
<summary>Roblox (1)</summary>

- [Software Engineer - Early Career](https://careers.roblox.com/jobs/8072244?gh_jid=8072244) — San Mateo, CA · posted 2026-08-05 · SWE · BS

</details>
<details open>
<summary>Schonfeld (1)</summary>

- [Market Data Analyst](https://job-boards.greenhouse.io/schonfeld/jobs/7843959) — NYC · posted 2026-04-30 · ML · BS

</details>
<details open>
<summary>The Voleon Group (1)</summary>

- [Software Engineer - University Hire 2027](https://jobs.ashbyhq.com/voleon/d732fd5a-ac98-4985-9e60-d1d59f02a66c/application?embed=true) — Berkeley, CA, NYC · posted 2026-08-25 · SWE · BS

</details>
<details open>
<summary>Together AI (1)</summary>

- [Software Engineer New Grad](https://job-boards.greenhouse.io/togetherai/jobs/5211582007) — SF · posted 2026-09-18 · SWE · BS

</details>
<details open>
<summary>Virtu Financial (1)</summary>

- [Software Engineer - Desktop Frontend Developer - C#/Winforms](https://job-boards.greenhouse.io/virtu/jobs/8516902002) — NYC · posted 2026-05-04 · SWE · BS

</details>
<details open>
<summary>Walleye Capital (1)</summary>

- [Quantitative Researcher - Single Stock Volatility](https://job-boards.greenhouse.io/walleyecapital-external-fulltime/jobs/4690167006) — Miami, FL · posted 2026-08-06 · Quant · BS/MS

</details>
<details open>
<summary>WorldQuant (1)</summary>

- [Quantitative Developer - Portfolio Management Solutions](https://job-boards.greenhouse.io/worldquant/jobs/4700347006) — Connecticut, NYC · posted 2026-08-13 · Quant · BS/MS

</details>
<details open>
<summary>Zoox (1)</summary>

- [Data Analyst - Hrs/wk](https://jobs.lever.co/zoox/ae2785ae-dfee-484b-8add-3cf32ca2d10e/apply) — Seattle, WA · posted 2026-09-10 · ML · BS/MS

</details>
<!-- JOBS:END -->
