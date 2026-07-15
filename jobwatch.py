#!/usr/bin/env python3
"""
jobwatch.py  —  daily new-grad job watcher for Alan.

Each run it:
  1. Pulls Simplify's New-Grad-Positions feed (~2k live roles, updated daily).
  2. Keeps roles that are: at a COMPANY on your list, in SWE / AI-ML / Quant,
     located in the US or Taiwan, and NOT PhD / Research-Scientist roles.
  3. Writes the current list into README.md (so your repo front page shows jobs)
     and into roles.json (data for the interactive tracker page, index.html).
  4. Remembers what it has already shown you (seen.json) and only pushes NEW
     postings to Telegram.

The company list IS your comp filter: every firm on it clears your bar.
No third-party packages needed. Setup: see README.md.
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG  — edit freely
# ─────────────────────────────────────────────────────────────────────────────

# Companies worth leaving Nuro/Cadence for. Matching:
#   multi-word ("jane street") -> substring on the name;
#   single word ("meta")       -> exact whole-word match (avoids collisions).
COMPANIES = [
    # big tech / high-TC product / fintech
    "google", "meta", "facebook", "apple", "amazon", "microsoft", "nvidia",
    "netflix", "linkedin", "uber", "airbnb", "snap", "pinterest", "doordash",
    "roblox", "databricks", "snowflake", "stripe", "coinbase", "adobe",
    "salesforce", "tiktok", "bytedance", "robinhood", "ramp", "figma",
    "palantir", "bloomberg", "plaid", "brex", "datadog", "cloudflare",
    "mongodb", "confluent", "atlassian", "reddit", "discord", "dropbox",
    "instacart", "lyft", "kraken", "rippling", "carta", "servicenow",
    "twilio", "okta", "gitlab", "github", "vercel",
    # AI labs / gen-AI
    "openai", "anthropic", "xai", "deepmind", "scale ai", "mistral", "cohere",
    "perplexity", "safe superintelligence", "thinking machines", "anysphere",
    "cursor", "character ai", "hugging face", "together ai", "fireworks",
    "baseten", "harvey", "glean", "world labs", "elevenlabs", "luma",
    # autonomy / robotics
    "zoox", "aurora", "cruise", "wayve", "applied intuition", "motional",
    "kodiak", "gatik", "waabi", "skild", "physical intelligence",
    "boston dynamics", "figure", "waymo", "tesla", "anduril", "shield ai",
    # AI chips / accelerators (your GPU/CUDA/EDA fit)
    "cerebras", "sambanova", "groq", "etched", "tenstorrent", "lightmatter",
    "d-matrix", "rivos",
    # top quant / HFT
    "jane street", "citadel", "two sigma", "hudson river", "jump trading",
    "d e shaw", "optiver", "imc", "akuna", "drw", "five rings", "susquehanna",
    "sig", "virtu", "tower research", "pdt", "point72", "millennium",
    "balyasny", "aqr", "squarepoint", "voleon", "cubist", "worldquant", "xtx",
    "vatic", "chicago trading", "belvedere", "wolverine", "hrt", "radix",
    "old mission", "headlands", "group one", "peak6", "quantlab", "qube",
    "bridgewater", "schonfeld", "walleye", "exoduspoint", "verition",
    "flow traders", "geneva trading", "wintermute", "marshall wace", "man group",
    # NOTE: "nuro" and "cadence" omitted (you already have offers).
]

# Companies that merely *contain* a fragment but aren't the one you mean.
DENY = {
    "snap-on", "coherent", "primetals", "metalcraft", "metalsa",
    "millennium space systems",  # defense/space, not Millennium the hedge fund
    "snap finance",              # lender, not Snap Inc
    "wolverine world wide",      # the shoe company, not Wolverine Trading
    "kraken robotics",           # marine defense, not Kraken the exchange
}

# Role families to keep (Simplify's `category`). Add "Hardware" for EE/embedded.
ROLE_CATS = {
    "Software", "Software Engineering",
    "AI/ML/Data", "Data Science, AI & Machine Learning",
    "Quant",
}

# Drop roles whose title contains any of these (case-insensitive).
EXCLUDE_TITLE_KEYWORDS = [
    "phd", "ph.d", "ph d", "research scientist",
    "postdoc", "post-doc", "post doc", "doctoral",
]

# Sponsorship values to drop (F-1 friendly). Most rows say "Other", so we only
# exclude explicit no's rather than requiring a "yes".
BAD_SPONSORSHIP = {"U.S. Citizenship is Required", "Does Not Offer Sponsorship"}

# Regions to keep (plus Remote and blank locations). Options: "US", "TW".
ALLOWED_REGIONS = {"US", "TW"}

# Ignore postings older than this many days.
MAX_AGE_DAYS = 75

# Data feeds. Add more only if they use Simplify's JSON schema.
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
ROLES_FILE = "roles.json"
COMPANIES_FILE = "companies.json"   # editable from the tracker page
README_FILE = "README.md"
JOBS_START = "<!-- JOBS:START -->"
JOBS_END = "<!-- JOBS:END -->"
ARCHIVE_DAYS = 180                  # keep closed roles this long so applied history persists

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

CAT_TAG = {"Quant": "Quant", "AI/ML/Data": "ML",
           "Data Science, AI & Machine Learning": "ML",
           "Software": "SWE", "Software Engineering": "SWE"}


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())).strip()


def load_companies():
    """The tracked-company list. Editable from the tracker page via companies.json;
    falls back to the built-in COMPANIES default (and seeds the file) if absent."""
    if os.path.exists(COMPANIES_FILE):
        try:
            data = json.load(open(COMPANIES_FILE))
            if isinstance(data, list):
                cleaned = sorted({str(x).strip().lower() for x in data if str(x).strip()})
                if cleaned:
                    return cleaned
        except Exception:
            pass
    try:
        json.dump(sorted(set(COMPANIES)), open(COMPANIES_FILE, "w"), ensure_ascii=False, indent=1)
    except Exception:
        pass
    return sorted(set(COMPANIES))


def match_company(name: str, companies) -> bool:
    n = _norm(name)
    if n in {_norm(x) for x in DENY}:
        return False
    ws = set(n.split())
    for frag in companies:
        frag = frag.lower()
        if " " in frag:
            if frag in n:
                return True
        elif frag in ws:
            return True
    return False


def region_ok(locations) -> bool:
    if not ALLOWED_REGIONS or not locations:
        return True  # no filter, or unknown location -> keep
    for loc in locations:
        low = loc.lower()
        if "US" in ALLOWED_REGIONS:
            if any(h in low for h in US_HINTS):
                return True
            for tok in re.split(r"[,\s/]+", loc.strip()):
                if tok.upper() in US_STATES:
                    return True
        if "TW" in ALLOWED_REGIONS and any(h in low for h in TW_HINTS):
            return True
    return False


def title_excluded(title: str) -> bool:
    t = (title or "").lower()
    return any(k in t for k in EXCLUDE_TITLE_KEYWORDS)


def cat_tag(category: str) -> str:
    return CAT_TAG.get(category, "SWE")


def ago(ts: float) -> str:
    d = (time.time() - ts) / 86400
    return "today" if d < 1 else f"{int(d)}d ago"


def pages_url():
    """The repo's GitHub Pages URL, if we can infer it (works inside Actions)."""
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if "/" in repo:
        owner, name = repo.split("/", 1)
        return f"https://{owner}.github.io/{name}/"
    return None


def fetch_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "jobwatch/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def normalize(record: dict, schema: str):
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
    fetched_ok = False
    companies = load_companies()
    for src in SOURCES:
        try:
            raw = fetch_json(src["url"])
            fetched_ok = True
        except Exception as e:
            print(f"[warn] could not fetch {src['name']}: {e}", file=sys.stderr)
            continue
        for rec in raw:
            r = normalize(rec, src["schema"])
            if not r or not r["active"]:
                continue
            if r["category"] not in ROLE_CATS:
                continue
            if title_excluded(r["title"]):
                continue
            if r["sponsorship"] in BAD_SPONSORSHIP:
                continue
            if now - r["date_posted"] > MAX_AGE_DAYS * 86400:
                continue
            if not match_company(r["company"], companies):
                continue
            if not region_ok(r["locations"]):
                continue
            out[r["id"]] = r
    return out, fetched_ok


def load_seen() -> set:
    if os.path.exists(SEEN_FILE):
        try:
            return set(json.load(open(SEEN_FILE)))
        except Exception:
            return set()
    return set()


def save_seen(ids: set):
    json.dump(sorted(ids), open(SEEN_FILE, "w"))


# ── outputs: roles.json (for the tracker) + README section (for browsing) ──

def write_roles_json(matches: dict):
    """Cumulative store: current matches are active=true; roles that have dropped out of
    the feed are kept as active=false for ARCHIVE_DAYS so the tracker can still show ones
    you marked (applied/seen/saved). Older closed roles are pruned."""
    now = time.time()
    prev = {}
    if os.path.exists(ROLES_FILE):
        try:
            for r in json.load(open(ROLES_FILE)):
                if isinstance(r, dict) and r.get("id"):
                    prev[r["id"]] = r
        except Exception:
            prev = {}

    merged, active_ids = {}, set()
    for r in sorted(matches.values(), key=lambda x: -x["date_posted"]):
        active_ids.add(r["id"])
        merged[r["id"]] = {
            "id": r["id"],
            "company": r["company"],
            "title": r["title"],
            "location": ", ".join(r["locations"][:3]) or "location N/A",
            "url": r["url"],
            "category": cat_tag(r["category"]),
            "posted": ago(r["date_posted"]),
            "date_posted": r["date_posted"],
            "active": True,
            "first_seen": prev.get(r["id"], {}).get("first_seen", now),
            "last_seen": now,
        }
    for rid, r in prev.items():
        if rid in active_ids:
            continue
        last = r.get("last_seen", r.get("date_posted", now))
        if now - last > ARCHIVE_DAYS * 86400:
            continue  # prune long-closed roles
        rr = dict(r)
        rr["active"] = False
        merged[rid] = rr

    out = sorted(merged.values(), key=lambda x: (0 if x.get("active") else 1, -x.get("date_posted", 0)))
    json.dump(out, open(ROLES_FILE, "w"), ensure_ascii=False, indent=1)


def jobs_markdown(matches: dict) -> str:
    from collections import defaultdict
    g = defaultdict(list)
    for r in matches.values():
        g[r["company"]].append(r)
    order = sorted(g, key=lambda c: (-len(g[c]), c.lower()))
    url = pages_url()
    tracker = (f"**[Open the interactive tracker]({url})** — tick/cross each role and "
               f"your marks are remembered.\n" if url
               else "_Turn on GitHub Pages to get the interactive tracker (see Setup below)._\n")
    lines = [f"_{len(matches)} open new-grad SWE / ML / Quant roles at {len(g)} target "
             f"companies. Auto-updated on every run._\n", tracker]
    for c in order:
        rows = sorted(g[c], key=lambda r: -r["date_posted"])
        lines.append(f"\n### {c} ({len(rows)})")
        for r in rows:
            loc = ", ".join(r["locations"][:3]) or "location N/A"
            title = r["title"].replace("[", "(").replace("]", ")").replace("|", "/")
            lines.append(f"- [{title}]({r['url']}) &mdash; {loc} · {ago(r['date_posted'])} · {cat_tag(r['category'])}")
    return "\n".join(lines) + "\n"


def update_readme(matches: dict):
    section = JOBS_START + "\n" + jobs_markdown(matches) + JOBS_END
    try:
        txt = open(README_FILE, encoding="utf-8").read()
    except FileNotFoundError:
        txt = "# jobwatch\n\n" + JOBS_START + "\n" + JOBS_END + "\n"
    if JOBS_START in txt and JOBS_END in txt:
        pre = txt.split(JOBS_START)[0]
        post = txt.split(JOBS_END, 1)[1]
        txt = pre + section + post
    else:
        txt = section + "\n\n" + txt
    open(README_FILE, "w", encoding="utf-8").write(txt)


# ── Telegram push (no emoji) ──

def fmt_role(r: dict) -> str:
    loc = ", ".join(r["locations"][:3]) or "location N/A"
    return f"[{cat_tag(r['category'])}] {r['company']} - {r['title']}\n   {loc}\n   {r['url']}"


def chunk(lines, header, limit=3500):
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
        "chat_id": chat, "text": text, "disable_web_page_preview": "true",
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
    sent = False
    for m in messages:
        sent = send_telegram(m) or sent
    if not sent:
        print("-- No Telegram creds set; printing messages to stdout --\n")
        print("\n\n".join(messages) if messages else "(nothing to push)")


def main():
    matches, fetched_ok = collect_matches()

    # If every feed failed (network hiccup, moved URL, etc.), keep the last good
    # roles.json / README instead of blanking them, and don't touch state.
    if not fetched_ok:
        print("[warn] all feeds failed to fetch; keeping last good data, skipping this run")
        return

    write_roles_json(matches)   # data for the tracker page
    update_readme(matches)      # jobs list on the repo front page

    seen = load_seen()
    first_run = not os.path.exists(SEEN_FILE)

    if first_run:
        from collections import Counter
        by = Counter(r["company"] for r in matches.values())
        lines = [f"{n:>3}  {c}" for c, n in sorted(by.items(), key=lambda x: (-x[1], x[0]))]
        url = pages_url()
        tail = f"\nTracker: {url}" if url else ""
        header = (f"jobwatch is live. Watching {len(matches)} open new-grad SWE/ML/Quant "
                  f"roles across {len(by)} target companies. The README lists them all; "
                  f"new postings will be pushed here (with links).{tail}")
        deliver(list(chunk(lines, header)))
        save_seen(set(matches.keys()))
        print(f"[ok] seeded {len(matches)} roles")
        return

    new = [r for rid, r in matches.items() if rid not in seen]
    new.sort(key=lambda r: (-r["date_posted"], r["company"]))

    if not new:
        print(f"[ok] no new roles ({len(matches)} tracked)")
        save_seen(set(matches.keys()) | seen)
        return

    header = f"{len(new)} new role(s) at your target companies:"
    deliver(list(chunk([fmt_role(r) for r in new], header)))
    save_seen(set(matches.keys()) | seen)
    print(f"[ok] pushed {len(new)} new role(s)")


if __name__ == "__main__":
    main()
