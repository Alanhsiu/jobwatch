# jobwatch

A set-it-and-forget-it watcher that sends **one Telegram message a day** with *new*
new-grad SWE / AI-ML / Quant roles at the ~35 companies worth leaving your Nuro/Cadence
offers for. Most days it's silent. When your 2027 targets start posting (the wave opens
around **fall 2026**), you get pinged — no daily browsing.

It runs on **GitHub Actions** (free), pulling a big community feed
([Simplify's New-Grad-Positions](https://github.com/SimplifyJobs/New-Grad-Positions),
~2,000 live roles updated daily) and filtering it down to your list.

---

## The one idea behind it

Postings don't list total comp, so you can't filter on "TC > 200k" directly.
Instead, **the company list in `jobwatch.py` *is* your comp filter** — every firm on it
already clears your bar. Anything the bot sends is worth a look. Tune the list with the
[Levels.fyi entry-level leaderboard](https://www.levels.fyi/leaderboard/Software-Engineer/Entry-Level-Engineer/country/United-States/).

---

## Setup (~15 min, once)

### 1. Make a Telegram bot (2 min)
1. In Telegram, message **@BotFather** → send `/newbot` → follow prompts.
2. It gives you a **bot token** like `8123456789:AAE...`. Copy it.
3. Send your new bot any message (say "hi") so it's allowed to message you.

### 2. Get your chat ID (1 min)
- Message **@userinfobot** in Telegram; it replies with your numeric **Id**.
  (Or open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser after
  texting your bot, and read `chat.id` from the JSON.)

### 3. Put these three files in a new GitHub repo
```
your-repo/
├── jobwatch.py
├── README.md
└── .github/
    └── workflows/
        └── jobwatch.yml
```
Private repo is fine (uses your free Actions minutes; a 2×/day run is trivial).

### 4. Add two repo secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**:
- `TELEGRAM_BOT_TOKEN` → the token from step 1
- `TELEGRAM_CHAT_ID` → the id from step 2

### 5. Run it once
Repo → **Actions** tab → **jobwatch** → **Run workflow**.
- First run sends a summary ("watching N roles across M companies") and seeds its memory.
- After that it only pings you about **new** postings, twice a day.

Done. Ignore it until it messages you.

---

## Tuning

All knobs are at the top of `jobwatch.py`:

| Setting | What it does |
|---|---|
| `COMPANIES` | Your target list. Multi-word = substring match; single word = exact word match. |
| `ROLE_CATS` | Role families. Add `"Hardware"` to include EE/embedded (off by default — usually below your bar). |
| `US_ONLY` → `ALLOWED_REGIONS` | Regions to keep: `{"US","TW"}` by default (plus Remote and blank locations). Drop `"TW"` for US-only, or empty the set to allow anywhere. |
| `MAX_AGE_DAYS` | Ignore postings older than this. |
| `SOURCES` | Feeds. Only add feeds that use Simplify's JSON schema. |

To reset its memory (re-seed from scratch), delete `seen.json` and run again.

---

## Prefer email instead of Telegram?

Swap the `send_telegram()` function for SMTP (Gmail with an
[App Password](https://myaccount.google.com/apppasswords)):

```python
import smtplib
from email.mime.text import MIMEText

def send_telegram(text):  # keep the name; it's the delivery hook
    user = os.environ.get("EMAIL_USER"); pw = os.environ.get("EMAIL_PASS")
    if not (user and pw):
        return False
    msg = MIMEText(text)
    msg["Subject"] = "jobwatch: new roles"
    msg["From"] = user; msg["To"] = user
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as s:
        s.login(user, pw); s.send_message(msg)
    return True
```
Then set `EMAIL_USER` / `EMAIL_PASS` as repo secrets instead of the Telegram ones.

---

## Notes & limits
- **Coverage** comes from Simplify. If a target company posts a new-grad role, Simplify
  almost always catches it within a day. You can add more feeds later, but one solid
  aggregator keeps this low-maintenance.
- **Taiwan roles**: the filter allows Taiwan, but Simplify is a *US* new-grad feed, so
  Taiwan coverage is thin (often zero). For real TW coverage you'd add a Taiwan source
  (e.g. Yourator / CakeResume, or specific company Taiwan career pages) as another entry
  in `SOURCES` with its own `normalize()` branch.
- **Sponsorship**: the feed's sponsorship field is usually blank, so the bot drops only
  roles explicitly marked "no sponsorship / citizenship required" — right call for F-1.
  Still verify any specific company in the USCIS H-1B Employer Data Hub / MyVisaJobs
  before investing time.
- **GitHub Actions** may pause scheduled runs after ~60 days of no repo activity; because
  this commits state on each run, it stays active on its own.
- `latest_digest.md` in the repo always holds the most recent output, even if a push fails.
