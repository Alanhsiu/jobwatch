#!/usr/bin/env python3
"""
jobwatch.py  —  a one-message-a-day new-grad job watcher for Alan.

What it does
------------
Every time it runs, it pulls a big, community-maintained feed of new-grad roles
(Simplify's New-Grad-Positions, ~2,000 active listings updated daily), keeps only
the ones that (a) are at a company on YOUR target list, (b) are SWE / AI-ML / Quant,
and (c) don't explicitly say "no sponsorship". It remembers what it has already
shown you (seen.json) and only pings you about *new* postings — so most days it
stays silent, and when your 2027 targets start posting, you get a single Telegram
message. No daily browsing.

Why a company allow-list instead of a salary filter
---------------------------------------------------
Job postings almost never list total comp, so "TC > 200k" can't be read off a
posting. Instead, the COMPANIES list below *is* your comp filter: every firm on it
clears your bar (big-tech / top quant / top AI labs). Anything the bot sends you is
therefore already worth a look. Trim or extend the list using the Levels.fyi
entry-level leaderboard.

Setup: see README.md (≈15 min, then zero daily effort).
No third-party packages needed — standard library only.
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG  — edit these freely
# ─────────────────────────────────────────────────────────────────────────────

# Companies you'd leave Nuro/Cadence for. Matching rules:
#   • multi-word entries ("jane street")  -> substring match on the company name
#   • single-word entries ("meta")        -> exact whole-word match (no collisions)
# Add/remove anything. Fragments are lowercase.
COMPANIES = [
    # --- big tech / high-TC product / fintech ---
    "google", "meta", "facebook", "apple", "amazon", "microsoft", "nvidia",
    "netflix", "linkedin", "uber", "airbnb", "snap", "pinterest", "doordash",
    "roblox", "databricks", "snowflake", "stripe", "coinbase", "adobe",
    "salesforce", "tiktok", "bytedance", "robinhood", "ramp", "figma",
    "palantir", "bloomberg", "plaid", "brex", "datadog", "cloudflare",
    "mongodb", "confluent", "atlassian", "reddit", "discord", "dropbox",
    "instacart", "lyft", "kraken", "rippling", "carta", "servicenow",
    "twilio", "okta", "gitlab", "github", "vercel",
    # --- AI labs / gen-AI (fits your ICLR / RLAIF background) ---
    "openai", "anthropic", "xai", "deepmind", "scale ai", "mistral", "cohere",
    "perplexity", "safe superintelligence", "thinking machines", "anysphere",
    "cursor", "character ai", "hugging face", "together ai", "fireworks",
    "baseten", "harvey", "glean", "world labs", "elevenlabs", "luma",
    # --- autonomy / robotics (your Nuro lane) ---
    "zoox", "aurora", "cruise", "wayve", "applied intuition", "motional",
    "kodiak", "gatik", "waabi", "skild", "physical intelligence",
    "boston dynamics", "figure", "waymo", "tesla", "anduril", "shield ai",
    # --- AI chips / accelerators (your GPU/CUDA/EDA fit) ---
    "cerebras", "sambanova", "groq", "etched", "tenstorrent", "lightmatter",
    "d-matrix", "rivos",
    # --- top quant / HFT (fits UC Capital + WorldQuant + your CAD wins) ---
    "jane street", "citadel", "two sigma", "hudson river", "jump trading",
    "d e shaw", "optiver", "imc", "akuna", "drw", "five rings", "susquehanna",
    "sig", "virtu", "tower research", "pdt", "point72", "millennium",
    "balyasny", "aqr", "squarepoint", "voleon", "cubist", "worldquant", "xtx",
    "vatic", "chicago trading", "belvedere", "wolverine", "hrt", "radix",
    "old mission", "headlands", "group one", "peak6", "quantlab", "qube",
    "bridgewater", "schonfeld", "walleye", "exoduspoint", "verition",
    "flow traders", "geneva trading", "wintermute", "marshall wace", "man group",
    # NOTE: "nuro" and "cadence" are intentionally omitted (you already have offers).
]

# Kill known substring collisions (companies that merely *contain* a fragment).
DENY = {
    "snap-on", "coherent", "primetals", "metalcraft", "metalsa",
    "millennium space systems",  # defense/space, not Millennium the hedge fund
    "snap finance",              # lender, not Snap Inc
    "wolverine world wide",      # the shoe company, not Wolverine Trading
    "kraken robotics",           # marine defense, not Kraken the exchange
}

# Which role families to keep (Simplify's `category` field).
ROLE_CATS = {
    "Software", "Software Engineering",
    "AI/ML/Data", "Data Science, AI & Machine Learning",
    "Quant",
    # Add "Hardware" if you want EE/embedded roles too (they usually pay below
    # your bar, so it's off by default).
}

# Sponsorship values to DROP (F-1 friendly). Note: most rows say "Other",
# so we only exclude the explicit no's rather than requiring a "yes".
BAD_SPONSORSHIP = {"U.S. Citizenship is Required", "Does Not Offer Sponsorship"}

# Keep roles located in any of these regions (plus Remote, plus unknown/blank
# locations, which are kept so nothing is silently dropped). Options: "US", "TW".
ALLOWED_REGIONS = {"US", "TW"}

# Ignore anything older than this many days (keeps the feed fresh).
MAX_AGE_DAYS = 75

# Data feeds. Simplify uses this schema; add more feeds only if they match it.
SOURCES = [
    {
        "name": "Simplify New-Grad",
        "url": "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
        "schema": "simplify",
    },
]

# ─────────────────────────────────────────────────────────────────────────────
# INTERNALS
# ─────────────────────────────────────────────────────────────────────────────

SEEN_FILE = "seen.json"
DIGEST_FILE = "latest_digest.md"

US_STATES = {
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
    "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
    "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
    "VA","WA","WV","WI","WY","DC",
}
US_HINTS = ("united states", "usa", "u.s.", "remote", "nyc", "bay area",
            "san francisco", "new york", "seattle", "austin", "boston",
            "los angeles", "san jose", "mountain view", "sunnyvale",
            "palo alto", "chicago", "atlanta", "denver", "dallas", "houston")
TW_HINTS = ("taiwan", "taipei", "new taipei", "hsinchu", "taichung", "tainan",
            "kaohsiung", "taoyuan")


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())).strip()


def match_company(name: str) -> bool:
    n = _norm(name).strip()
    if n in {_norm(x) for x in DENY}:
        return False
    ws = set(n.split())
    for frag in COMPANIES:
        frag = frag.lower()
        if " " in frag:
            if frag in n:
                return True
        elif frag in ws:
            return True
    return False


def region_ok(locations) -> bool:
    if not ALLOWED_REGIONS:
        return True
    if not locations:
        return True  # unknown -> keep
    for loc in locations:
        low = loc.lower()
        if "US" in ALLOWED_REGIONS:
            if any(h in low for h in US_HINTS):
                return True
            for tok in re.split(r"[,\s/]+", loc.strip()):  # "San Jose, CA"
                if tok.upper() in US_STATES:
                    return True
        if "TW" in ALLOWED_REGIONS and any(h in low for h in TW_HINTS):
            return True
    return False


def fetch_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "jobwatch/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def normalize(record: dict, schema: str) -> dict | None:
    if schema == "simplify":
        return {
            "id": f"simplify:{record.get('id')}",
            "company": (record.get("company_name") or "").strip(),
            "title": (record.get("title") or "").strip(),
            "locations": record.get("locations") or [],
            "category": record.get("category") or "",
            "url": record.get("url") or "",
            "sponsorship": record.get("sponsorship") or "",
            "date_posted": record.get("date_posted") or 0,
            "active": bool(record.get("active")) and bool(record.get("is_visible", True)),
        }
    return None


def collect_matches():
    now = time.time()
    out = {}
    for src in SOURCES:
        try:
            raw = fetch_json(src["url"])
        except Exception as e:
            print(f"[warn] could not fetch {src['name']}: {e}", file=sys.stderr)
            continue
        for rec in raw:
            r = normalize(rec, src["schema"])
            if not r or not r["active"]:
                continue
            if r["category"] not in ROLE_CATS:
                continue
            if r["sponsorship"] in BAD_SPONSORSHIP:
                continue
            if now - r["date_posted"] > MAX_AGE_DAYS * 86400:
                continue
            if not match_company(r["company"]):
                continue
            if not region_ok(r["locations"]):
                continue
            out[r["id"]] = r  # dedupe within/across feeds by id
    return out


def load_seen() -> set:
    if os.path.exists(SEEN_FILE):
        try:
            return set(json.load(open(SEEN_FILE)))
        except Exception:
            return set()
    return set()


def save_seen(ids: set):
    json.dump(sorted(ids), open(SEEN_FILE, "w"))


def fmt_role(r: dict) -> str:
    loc = ", ".join(r["locations"][:3]) or "location N/A"
    tag = {"Quant": "🧮", "AI/ML/Data": "🤖",
           "Data Science, AI & Machine Learning": "🤖"}.get(r["category"], "💻")
    return f"{tag} {r['company']} — {r['title']}\n   {loc}\n   {r['url']}"


def full_digest(matches: dict) -> str:
    """The complete current match list, grouped by company, with clickable links.
    Written to latest_digest.md on every run so the repo always has a browsable view."""
    from collections import defaultdict
    g = defaultdict(list)
    for r in matches.values():
        g[r["company"]].append(r)
    now = time.time()

    def ago(r):
        d = (now - r["date_posted"]) / 86400
        return f"{int(d)}d ago" if d >= 1 else "today"

    tag = {"Quant": "🧮", "AI/ML/Data": "🤖", "Data Science, AI & Machine Learning": "🤖"}
    order = sorted(g, key=lambda c: (-len(g[c]), c.lower()))
    out = ["# jobwatch — current matches (with links)\n",
           f"_{len(matches)} open new-grad SWE / AI-ML / Quant roles at {len(g)} "
           f"target companies. Auto-refreshed every run._\n"]
    for c in order:
        rows = sorted(g[c], key=lambda r: -r["date_posted"])
        out.append(f"\n## {c}  ({len(rows)})")
        for r in rows:
            loc = ", ".join(r["locations"][:3]) or "location N/A"
            t = tag.get(r["category"], "💻")
            title = r["title"].replace("[", "(").replace("]", ")").replace("|", "/")
            out.append(f"- {t} [{title}]({r['url']}) — {loc} · {ago(r)}")
    return "\n".join(out) + "\n"


def chunk(lines, header, limit=3500):
    """Yield Telegram-sized messages."""
    buf, size = [header], len(header)
    for ln in lines:
        if size + len(ln) + 2 > limit and len(buf) > 1:
            yield "\n\n".join(buf)
            buf, size = [header], len(header)
        buf.append(ln)
        size += len(ln) + 2
    if len(buf) > 1:
        yield "\n\n".join(buf)


def send_telegram(text: str) -> bool:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat = os.environ.get("TELEGRAM_CHAT_ID")
    if not (token and chat):
        return False
    data = urllib.parse.urlencode({
        "chat_id": chat,
        "text": text,
        "disable_web_page_preview": "true",
    }).encode()
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=30) as r:
            r.read()
        return True
    except Exception as e:
        print(f"[warn] telegram send failed: {e}", file=sys.stderr)
        return False


def deliver(messages):
    """Send the Telegram push messages (or print them if no creds are set)."""
    sent = False
    for m in messages:
        sent = send_telegram(m) or sent
    if not sent:
        print("── No Telegram creds set; printing messages to stdout ──\n")
        print("\n\n".join(messages) if messages else "(nothing to push)")


def main():
    matches = collect_matches()

    # Always refresh the browsable full list (with links) in the repo.
    open(DIGEST_FILE, "w").write(full_digest(matches))

    seen = load_seen()
    first_run = not os.path.exists(SEEN_FILE)

    if first_run:
        # Don't blast the whole backlog to Telegram — send one summary and seed state.
        # (The complete list with links is in latest_digest.md, written above.)
        from collections import Counter
        by_co = Counter(r["company"] for r in matches.values())
        lines = [f"{n:>3}  {c}" for c, n in sorted(by_co.items(), key=lambda x: (-x[1], x[0]))]
        header = (f"✅ jobwatch is live. Watching {len(matches)} open new-grad "
                  f"SWE/AI/Quant roles across {len(by_co)} target companies.\n"
                  f"Full list with links is in latest_digest.md. "
                  f"From now on I'll ping you about NEW postings (with links).")
        deliver(list(chunk(lines, header)))
        save_seen(set(matches.keys()))
        print(f"[ok] seeded {len(matches)} roles into {SEEN_FILE}")
        return

    new = [r for rid, r in matches.items() if rid not in seen]
    new.sort(key=lambda r: (-r["date_posted"], r["company"]))

    if not new:
        print(f"[ok] no new roles (still tracking {len(matches)} open).")
        save_seen(set(matches.keys()) | seen)  # keep closed roles so reposts can re-fire
        return

    lines = [fmt_role(r) for r in new]
    header = f"🔔 {len(new)} new new-grad role(s) at your target companies:"
    deliver(list(chunk(lines, header)))
    save_seen(set(matches.keys()) | seen)
    print(f"[ok] pushed {len(new)} new role(s).")


if __name__ == "__main__":
    main()
