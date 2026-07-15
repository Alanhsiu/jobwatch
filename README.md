# jobwatch

Watches new-grad **SWE / AI-ML / Quant** roles at your target companies and, each day,
pushes only the *new* ones to Telegram. The list below is refreshed automatically on every
run, and an interactive tracker page lets you manage each application through its pipeline.

<!-- JOBS:START -->
_The job list appears here after the bot runs for the first time._
<!-- JOBS:END -->

---

## How it works

- **Runs on GitHub Actions** (free) — your computer never needs to be on.
- Pulls [Simplify's New-Grad-Positions](https://github.com/SimplifyJobs/New-Grad-Positions)
  feed and keeps only roles that are: at a company on your list, SWE / AI-ML / Quant,
  in the **US or Taiwan**, and **not** PhD / Research-Scientist roles.
- The **company list is your comp filter** — every firm on it clears your bar, so anything
  that surfaces is worth a look. Tune it with the
  [Levels.fyi entry-level leaderboard](https://www.levels.fyi/leaderboard/Software-Engineer/Entry-Level-Engineer/country/United-States/).

Three surfaces:
- **This README** — the full current list (read-only), refreshed each run.
- **The tracker page** (`index.html` on GitHub Pages) — a full application tracker:
  - A per-role **stage dropdown**: To review → Seen → Applied → OA → Interviewing → Offer →
    Rejected → Dismissed. Rows are colour-coded by stage.
  - An editable **note** on any role (recruiter, deadline, referral, OA link, questions…).
  - A **★ save** toggle for favorites (independent of stage).
  - A **filter dropdown** (any stage / ★ Saved / All) + search, with a live count per stage.
  - A **Companies** panel to add/remove tracked companies, plus **Rescan now**.
  - Roles you've touched stay after a posting closes (shown "closed"), so your history persists.
  - Everything (stages, notes, stars, company list) syncs across devices via your repo.
- **Telegram** — a one-time summary, then only *new* postings (each with its link).

### Managing tracked companies
Open the tracker → **Companies** (top right) → add a keyword or remove a chip. This edits
`companies.json`, which the bot reads on its next scan. Hit **Rescan now** to apply
immediately (needs the token to also have **Actions: Read and write** — see step 5),
otherwise it applies on the next scheduled run.

---

## Setup (~15 min, once)

### 1. Make a Telegram bot
1. Message **@BotFather** → `/newbot` → follow prompts → copy the **token**.
2. Send your new bot any message so it's allowed to message you.
3. Message **@userinfobot** to get your numeric **chat id**.

### 2. Create a **public** repo with these files
```
your-repo/
├── jobwatch.py
├── index.html
├── roles.json          (scanned job data; refreshed by the bot, keeps closed roles you marked)
├── companies.json      (the tracked-company list; editable from the tracker page)
├── status.json         ({} — your stages, notes, and stars)
├── README.md
└── .github/workflows/jobwatch.yml
```
Make it **Public**. Nothing sensitive lives here (job listings + your progress); your
Telegram token goes in Secrets, never in the repo. Public is also what lets the tracker
page work for free (GitHub Pages on private repos needs a paid plan).

### 3. Add two repo secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**:
- `TELEGRAM_BOT_TOKEN` = the BotFather token
- `TELEGRAM_CHAT_ID` = your chat id

### 4. Turn on the tracker page (GitHub Pages)
Repo → **Settings → Pages** → *Build and deployment* → Source: **Deploy from a branch**
→ Branch: **main**, folder: **/ (root)** → **Save**.
Your tracker will be at `https://<your-username>.github.io/<repo>/` (the bot drops this
link into the README and your Telegram summary automatically).

### 5. (Optional) Turn on cross-device sync
By default the tracker keeps your stages/notes/stars in the browser you're using. To share
them across phone and laptop — and to edit the company list — the page reads/writes
`status.json` and `companies.json` in your repo via the GitHub API. Give it a token:
1. Create a **fine-grained token**: GitHub → Settings → Developer settings →
   Fine-grained tokens → *Generate new token*. Repository access = **Only select
   repositories → your jobwatch repo**. Permissions = **Contents: Read and write**
   (add **Actions: Read and write** for the Rescan button). Nothing else.
2. Open the tracker → **Sync** (top right) → paste `owner/repo` and the token → Save.
3. Repeat on each device you use. The token lives only in that device's browser; revoke it
   anytime in GitHub settings.

### 6. Run it once
Repo → **Actions** → **jobwatch** → **Run workflow**.
- Fills the job list into this README, writes `roles.json`, and Telegrams you a summary.
- After that it only pings you about **new** postings, twice a day.

Done — ignore it until it messages you.

---

## Tuning (top of `jobwatch.py`)

| Setting | What it does |
|---|---|
| `COMPANIES` | Default target list. On first run it seeds `companies.json`, which then becomes the live list you edit from the tracker's Companies panel. Multi-word = substring; single word = exact word match. |
| `EXCLUDE_TITLE_KEYWORDS` | Titles to drop (currently PhD / Research Scientist / postdoc). |
| `ROLE_CATS` | Role families. Add `"Hardware"` to include EE/embedded. |
| `ALLOWED_REGIONS` | `{"US","TW"}` by default (plus Remote/blank). Drop `"TW"` for US-only. |
| `MAX_AGE_DAYS` | Ignore postings older than this. |
| `ARCHIVE_DAYS` | How long closed roles stay in `roles.json` (so marked ones persist). |
| `SOURCES` | Feeds. Add only feeds that use Simplify's JSON schema. |

Reset the bot's "already notified" memory: delete `seen.json` and run again.

---

## Prefer email instead of Telegram?
Swap `send_telegram()` for SMTP (Gmail with an
[App Password](https://myaccount.google.com/apppasswords)):
```python
import smtplib
from email.mime.text import MIMEText
def send_telegram(text):            # keep the name; it's the delivery hook
    user, pw = os.environ.get("EMAIL_USER"), os.environ.get("EMAIL_PASS")
    if not (user and pw): return False
    msg = MIMEText(text); msg["Subject"] = "jobwatch"; msg["From"] = user; msg["To"] = user
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as s:
        s.login(user, pw); s.send_message(msg)
    return True
```
Then set `EMAIL_USER` / `EMAIL_PASS` as secrets instead of the Telegram ones.

---

## Notes & limits
- **Coverage** comes from Simplify. If a target company posts a new-grad role, Simplify
  almost always catches it within a day. If the feed ever fails to fetch, the bot keeps the
  last good `roles.json`/README instead of blanking them.
- **Applied/pipeline history**: `roles.json` keeps roles that dropped out of the feed for
  `ARCHIVE_DAYS` (180) so anything you marked stays visible in the tracker, labelled "closed".
  Unmarked closed roles just disappear.
- **Sync** is optional. With a token your stages/notes/stars (`status.json`) and company list
  (`companies.json`) match on every device; without one it's per-browser and the company list
  is read-only.
- **Taiwan** roles are allowed, but Simplify is a US-focused feed, so TW coverage is thin.
  Add a Taiwan source (e.g. Yourator / CakeResume) as another `SOURCES` entry for real TW.
- **Timing**: many roles you see in summer are 2026-start; the 2027 new-grad wave opens
  around fall — the bot will ping you as those appear.
- Scheduled Actions can pause after ~60 days of no repo activity; since this commits on
  every run, it keeps itself alive.
