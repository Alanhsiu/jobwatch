# Developing jobwatch

Read [README.md](README.md) first for what the product does. This file is about the code: where things live, the
interfaces that must not drift, and the routines (release, fixtures, tests) that keep them honest.

## Layout

```
jobwatch/
├── jobwatch.py                     bot, single file, sectioned (below); stdlib only
├── tools/backfill_marks.py         one-off, user-run: derive t/h for existing marks from git history
├── index.html                      tracker shell: <html data-app="N">, CSP meta, dialogs, static #list fallback text
├── assets/
│   ├── lib.js                      PURE: APP_VERSION, STAGES, norm, groupKey, parseMarks, serializeMarks, mergeMarks,
│   │                               entryTime, buildView, hashToView/viewToHash, rel, toCSV, validateConfig, DEFAULT_CONFIG
│   ├── sync.js                     DOM-free: createSync({fetch, storage, now, online, ...}) — GitHub client, sync engine,
│   │                               list RMW, rescan polling, health. Imports lib.js only.
│   ├── app.js                      DOM: boot, render/patchRow, dialogs, keyboard, toasts, announcer. Imports lib.js + sync.js.
│   ├── style.css                   tokens (light/dark), layout, components, mobile, forced-colors, minimal print
│   └── icon.svg                    manifest icon
├── manifest.webmanifest            short_name "jobwatch", start_url "./", scope "./", display standalone
├── ruff.toml                       [lint] select = ["E4","E7","E9","F"]
├── .github/workflows/jobwatch.yml  schedule + push.paths + dispatch(inputs); pinned SHAs; commit retry; failure notify
├── .github/workflows/ci.yml        PR/push: ruff, py_compile, pytest, node --check, node --test, check_html; e2e job non-blocking
├── .github/dependabot.yml          github-actions, monthly
├── tests/
│   ├── conftest.py                 tmp state dir, frozen clock, fake feed, fake telegram, fake git
│   ├── make_vectors.py             spec-exact generator of fixtures/vectors.json (imports jobwatch); prints the matching numbers
│   ├── check_html.py               CSP present, no inline style/script, data-app + every ?v= equal APP_VERSION, manifest link
│   ├── fixtures/listings_subset.json  expected.json  vectors.json (shared Python/JS tables, generated)
│   ├── fixtures/config_vectors.json   hand-maintained config.json accept/reject verdicts, run by both suites
│   ├── fixtures/real/              read-only copies of the five state files + index.v1.html (compat e2e)
│   ├── test_*.py                   io, config, match, region, pipeline, roles_model, telegram, readme, cli, backfill, golden,
│   │                               workflow (runs the Notify step's script with a fake gh/curl; bash -n on every run: block)
│   └── js/                         lib, merge, sync, version, contrast (.test.mjs; node:test, no DOM)
└── e2e/                            package.json, package-lock.json (committed), ghmock.mjs, fixtures/, *.spec.mjs (7 specs)
```

Not in the PR, created at runtime: `config.json` (Settings → Save, or by hand) and `meta.json` (first bot run).
`roles.json seen.json status.json companies.json manual.json` are live state — never edit them in a PR.

## `jobwatch.py` section order

Numbered banners, fixed order: `0 constants/defaults · 1 io (atomic write, load_json) · 2 config · 3 text/normalise ·
4 matching (pure) · 5 region · 6 feed fetch + gates · 7 roles model (pure) · 8 outputs (roles/README/meta) · 9 telegram ·
10 run() · 11 CLI`. Sections 3–5 and 7 are pure: no I/O, no clock — `now` is a parameter. `run()` calls
`write_outputs()` exactly once, as its last action before computing the exit code; everything before it is read-only on
disk (the companies.json seed lives inside `write_outputs`). `python3 jobwatch.py` is the entry point; tests
`import jobwatch`.

Delivery has one call site — `send_telegram()` in section 9. To use e-mail instead, replace its body with an SMTP send
and keep its signature and `(ok, err)` return; nothing else changes.

## Who writes what

| File | Writer(s) | Never written by |
|---|---|---|
| `roles.json`, `seen.json`, `meta.json`, `README.md` (generated sections) | bot | page |
| `status.json` | page; `tools/backfill_marks.py` (the user runs it) | bot |
| `companies.json` | page; bot **only** seeds when the file is absent | bot when the file exists (even `[]`) |
| `manual.json` | page | bot |
| `config.json` | page (Settings) or hand | bot |

The workflow stages exactly `roles.json seen.json meta.json README.md` (+ `companies.json` only when the run log
contains `::notice::seeded companies.json`). Disjoint write sets are why the bot's rebase never conflicts with a page
commit.

## Exit codes (the workflow depends on them)

| Code | Meaning | Files written | Workflow effect |
|---|---|---|---|
| 0 | success incl. "no change"; also Telegram **partial** failure (`::warning::`) | as needed (possibly none) | commit if diff |
| 1 | feed unavailable or degenerate after retries/gates | **none** | red; notify debounced (2nd consecutive scheduled feed failure) |
| 2 | a state/config file exists but is corrupt / wrong shape; also any unexpected internal error (traceback in the run log) | **none** | red; notify now (workflow only) |
| 3 | outputs written; Telegram creds set and **every** chunk failed | all, `seen` unchanged | commit runs (`if: !cancelled()`); red; notify |
| 4 | archive gate or zero-match gate tripped | **none** | red; notify now (workflow only; "re-run with force") |
| 5 | usage / CLI error | none | red |

Every exit-1 message is printed as `::error::feed: …`; the notify step greps the two previous scheduled runs' logs for
that prefix to measure the streak, and when `gh` cannot list the runs or read a log it alerts rather than stay silent
(an API incident must not hide a feed outage). Inside Actions that step is the **only** Telegram sender for failures:
`ops_alert()` — the one-line exit-2/4 alert from Python (spec §7.8) — returns early when `GITHUB_ACTIONS` is set and
fires only on local runs, so a tripped gate produces one message, not two. `[info]/[warn]/[error]` go to stderr;
`::warning::`/`::error::`/`::notice::` annotations to stdout when `GITHUB_ACTIONS` is set.

## Interface freeze

Change these only by editing the spec first, then every consumer in the same PR: every file schema (roles.json,
meta.json, config.json, status.json, seen.json, companies.json, manual.json); the exit-code table above; the
`::notice::seeded companies.json` grep string; the workflow's staged-file list; the CLI flags (`--dry-run --feed
--no-notify --verbose --state-dir --config --force --explain --version`); the `APP_VERSION` handshake (`data-app` +
`?v=`); the contents of `tests/fixtures/vectors.json`; the localStorage keys (`jobwatch.marks.v3`, `jobwatch.dirty.v1`,
`jobwatch.migrated.v3`, `jobwatch.trash.v1`, `jobwatch.ui.v1`, `jobwatch.lastVisit`, `jobwatch.gh.repo`,
`jobwatch.gh.pat`, `jobwatch.sync.off`, `jobwatch.sync.v1`, session `jobwatch.reloaded.<N>`); the meta.json fields the
page reads (`repo`, `branch`, `pages_url`, `last_run`, `last_change`, `last_result`, `counts`, `keywords`,
`telegram.mode`, `config_sha`, `warnings`); the `::error::feed:` log prefix; the `parse_marks` table in vectors.json;
the `Chunk.ids` invariant (folded `+N more at <Co>` ids belong to the chunk; ids cut by `max_messages_per_run` belong
to no chunk and are re-announced).

## Adding a config key

1. `jobwatch.py` `DEFAULT_CONFIG`: the default, plus its entry in the type table the loader validates (wrong type ⇒
   exit 2 naming the key; regex fragments compile through the bounded wrapper and fall back to the default with a
   `meta.warnings` entry).
2. `assets/lib.js` `DEFAULT_CONFIG` (mirrors the Python default — the Settings textarea prefill) and the matching type in
   `validateConfig` so Settings → Validate agrees with the bot.
3. `README.md` → Configuration table: key · default · effect.
4. Tests: a `test_config.py` case for the type check and a `lib.test.mjs` case for `validateConfig`; if the key changes
   matching, regenerate the fixtures (below) and refresh `tests/fixtures/expected.json`.

## Release checklist (page)

1. Bump `APP_VERSION` in `assets/lib.js` and every reference: `assets/style.css?v=N` and `assets/app.js?v=N` in
   `index.html`, `./lib.js?v=N` / `./sync.js?v=N` in `app.js`, and `<html data-app="N">`. `node --test 'tests/js/*.test.mjs'`
   (`version.test.mjs`) and `python3 tests/check_html.py` fail on any drift.
2. Merge. Pages redeploys within ~1 min; browsers holding the old page keep it ≤ 10 min. On boot, a page whose
   `data-app` disagrees with the `APP_VERSION` it loaded does one guarded reload (`sessionStorage['jobwatch.reloaded.N']`),
   then shows the "newer version exists" banner instead of looping.
3. Data files are read with `cache: 'no-store'`; schema tolerance covers old page + new data and new page + old data.

Bot releases bump `BOT_VERSION` in `jobwatch.py` (surfaces as `meta.bot_version` and `--version`; `USER_AGENT` is a
separate literal). `meta.version` is the *schema* version of roles.json and meta.json — `SCHEMA_VERSION = 2` in
`jobwatch.py`, written by `build_meta`, independent of the page's `APP_VERSION` — bump it only when the shape of those
files changes, and add the in-memory migration for older rows next to the existing ones.

## Regenerating fixtures

- `tests/fixtures/vectors.json`: `python3 tests/make_vectors.py` — imports `jobwatch`, writes the shared `norm`,
  `group_key`, `region`, `iso_date` and `parse_marks` tables, and prints the matching numbers for the PR body. Run it
  after any change to `norm`, `group_key`, the region tables or the status.json loader; both test suites load the file,
  so a change in one language without the other fails CI.
- `tests/fixtures/listings_subset.json` (~150 records that hit every rule) and `tests/fixtures/expected.json`: download
  the live feed into a scratch directory outside the repo (`curl -o /tmp/listings.json <feed_url>` — the root-level
  `/listings*.json` pattern in `.gitignore` keeps a stray copy out of commits), select one record per rule (each region string
  class, the PhD / degree combinations, title excludes and keeps, hardware include vs exclude titles, deny-list names,
  a sponsorship reject, aged-out known and unknown ids, an inactive record, a 3-posting group), keep the ids stable, and
  re-run `python3 -m pytest -q`. Never commit the full
  feed (13 MB).
- `tests/fixtures/real/` are read-only snapshots of the five state files and the v1 tracker taken at PR time; do not
  regenerate them casually — `test_golden.py` and the `compat-*` e2e specs assert against them.

## Tests

| Suite | Command | Notes |
|---|---|---|
| Python | `python3 -m pytest -q` | offline, deterministic, < 10 s; `ruff check jobwatch.py tools tests` must be clean; includes `test_workflow.py` (bash -n on every `run:` block, the Notify step against a fake `gh`/`curl`) |
| JS unit | `node --test 'tests/js/*.test.mjs'` | ESM, no DOM; `node --check assets/*.js` first |
| HTML | `python3 tests/check_html.py` | CSP, no inline style/script, version stamps, manifest link |
| Playwright | `cd e2e && npm ci`, then from the repo root `PW_CHANNEL=chrome node --test 'e2e/*.spec.mjs'` | serves a **copy** of the repo root and mocks `api.github.com` in-page (`e2e/ghmock.mjs`); `PW_CHANNEL=chrome` uses the system Chrome (the bundled chromium is not installed locally); CI installs chromium and leaves it unset |

Local rules: never run `jobwatch.py` inside your clone without `--state-dir <dir outside the repo>` and `--dry-run` (or
`--feed`); never edit the five state files by hand; serve the page from a copy (`cp -r . /tmp/jw-page`); kill any
`http.server` you start.

## CI

`ci.yml` runs on every pull request and on pushes to `main` that touch code (bot commits are excluded by `[skip ci]` and
by `paths-ignore`). The `test` job is blocking; the `e2e` job runs after it with `continue-on-error: true` — real-browser
specs are advisory. `jobwatch.yml` is the bot: `23 */2 * * *`, `push.paths` on `jobwatch.py config.json companies.json`,
and `workflow_dispatch` with `dry_run` / `force` inputs; the run step tees its output to `.jobwatch-run.log` (gitignored)
and exports the exit code, the commit step retries `pull --rebase && push` five times with `rebase --abort` between
attempts, and the notify step Telegrams failures (feed failures once per streak of scheduled runs — or at once when the
run history cannot be read). `tests/test_workflow.py` runs that step's script with a fake `gh`/`curl` for every branch of
the decision. Actions are pinned by SHA with the version in a trailing comment; re-resolve with
`git ls-remote --tags https://github.com/<owner>/<repo>` (not the API). Dependabot opens a PR monthly when a pin is stale.

## Rollback (v2 → v1)

`git revert -m 1 <merge-sha>` (plain `git revert <sha>` after a squash merge) — **expect a conflict in `README.md`**:
the `push.paths` trigger runs the bot within about a minute of the merge, and its `[skip ci]` state commit refills the
generated sections the merge left as placeholders, so the merge's README hunks no longer apply. Resolve by taking the
pre-merge copy — `git checkout <merge-sha>^1 -- README.md && git add README.md && git revert --continue` — then push.
Do **not** revert the bot's state commits: `seen.json` must keep the ids announced during the v2 period or the v1 bot
Telegrams them again. The v1 bot reads v2 `roles.json` / `seen.json` (it needs only `id`, `date_posted`, `first_seen`,
`last_seen`), drops the extra fields on its next run and rewrites the README list between the surviving markers;
`meta.json` stays behind and is ignored. The v1 page ignores `t` / `h` / `d` in `status.json` and strips them on its
next push. One sharp edge: localStorage `jobwatch.marks.v2` is frozen at migration and the v1 page re-pushes every local
id the remote lacks, so marks deleted (tombstoned) during the v2 period come back on each device's first v1 boot —
clear `jobwatch.marks.v2` on each device (DevTools → Application → Local Storage) before rolling back, or re-dismiss them.

## Deliberately NOT built

| Item | Source | Why not |
|---|---|---|
| Alias table (canonical company → patterns) | D3 | Normalised word-bounded keywords + deny reproduce every real case; only "X Development" would be gained (1 role, add a keyword); a second place to edit names. |
| `suggestions.json` / untracked-company panel | 118 | 631 untracked names dominated by defence/consulting; no comp signal in the feed. |
| Private state repo / client-side note encryption / git-history purge | 010 067 068 | Stages are already in public history; two-repo sync + second Actions secret; encryption breaks mirror and prune protection; force-push of public history has more risk than value. Documented recipe instead. |
| Owner-tagged `seen.json` / template mode | 081 039 103 | 0 forks; a README fork checklist covers it. |
| External cron dispatcher / dead-man's switch | 032 033 | C2; 2 h cadence + heartbeat + debounced failure step suffice. |
| `state` branch or Pages-via-Actions deploy | 135 | Coalesced pushes already cut commits; the 10 builds/h soft limit never throttled in practice. |
| Location chips | 049 | Multi-city strings; search covers "seattle"; a row of controls on phones. |
| Full print stylesheet with inlined URLs | 110 | Measured 30 → 34 pages; minimal chrome-hiding only. |
| Roving tabindex | 087 | Focus restore + `j/k` cursor is enough. |
| `synced` id set, Trash UI, sync log viewer, Import JSON, `navigator.locks`, keepalive flush, session-only token, token-expiry banner | RF/UF | Zero daily value for one user; each is a moving part. Invisible `trash.v1` stash + download link kept. |
| `_v` top-level key in status.json | RF | Every consumer would special-case it. |
| `!keyword` deny syntax in companies.json | RF 145 | Plain string list stays plain; "Block this name" writes `config.deny`. |
| `max(date_posted, date_updated)` age rule | 025 066 | `date_updated` is ingestion time and bulk-bumped (450/2,898 in a day); sticky-once-tracked fixes the real defect. |
| Match-shrink ratio gate | 026 028 094 | TikTok is 39 % of matches; false-positives on intentional trims; closed-only gate + zero-match gate instead. |
| seen.json pruning / `seen ⊆ roles` invariant | 126 129 | ~10 ids/day; semantic change for no benefit. |
| Old-browser feature-detect script | 115 | `type="module"` is ignored by pre-2018 engines; static fallback text suffices. |
| Status marks rendered into README | 101 | Publishes the pipeline more prominently; the tracker is the live view. |
| `setup-python` action | 122 | ubuntu-24.04 ships Python 3.12; one fewer third-party pin. |
| Multiple `SOURCES` abstraction, SMTP snippet, `--print-matches`, sha256 asset stamping | current code / UF | One feed (`feed_url`); dead weight; `--dry-run --verbose`; integer version + handshake. |
| `date_updated` stored in roles.json | v1 spec | Simplify bulk-bumps it (18/269 matched rows within 24 h on the live snapshot); every bump = a commit + Pages deploy for a field described as "informational (tooltip)". `--verbose` still prints it. |
| `meta.config_hash` (sha256 of a canonical config serialisation mirrored in JS) | v1 spec | Any divergence in key order, separators, `ensure_ascii` or float formatting between `json.dumps` and `JSON.stringify` makes the banner permanently wrong; Web Crypto is async and secure-context-only. Replaced by the git blob sha GitHub already returns (§5.2). |
| `golden_status_parse_py_js_equivalence` via a node subprocess from pytest | v1 spec | pytest would depend on node; the shared `vectors.json` `parse_marks` table gives the same guarantee to both suites. |
| Playwright specs beyond the 7 in §12.3 (focus-keyboard, dark-and-a11y, sync-deletion, sync-offline, sync-reset-and-orphans, rescan) | v1 spec | Pure engine logic — node:test against fakes is faster and deterministic; the brief asked for a smoke test. |
| Weekly dependabot | v1 spec | Monthly: SHA-pinned actions do not rot; weekly PRs are noise for a solo repo. |
| Match-shrink gate as a *feed* gate? No — but a feed-level `min_active_ratio` **is** built (§7.3) | critique | Different thing: it compares the feed's own live count with the last recorded one (worst legitimate drop 4 %, threshold 30 %), not the match count. |

## When to split `jobwatch.py`

Keep the single file. Split into a package only when it passes ~1,600 lines or a second entry point appears; until
then the numbered sections are the module boundaries.
