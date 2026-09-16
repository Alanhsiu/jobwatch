#!/usr/bin/env python3
"""jobwatch — new-grad job watcher.

Every run: fetch Simplify's New-Grad feed, keep the roles that match your company
list and filters, write roles.json / README.md / meta.json, and send the roles you
have not been told about to Telegram. Stdlib only. `python3 jobwatch.py --help`.

Sections (fixed order; see DEVELOPING.md):
  0 constants/defaults  1 io  2 config  3 text/normalise  4 matching  5 region
  6 feed fetch + gates  7 roles model  8 outputs  9 telegram  10 run()  11 CLI
Sections 3-5 and 7 are pure: no I/O, no clock (`now` is a parameter).
"""

import argparse
import copy
import functools
import hashlib
import html
import http.client
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# ── 0  constants / defaults ─────────────────────────────────────────────────

BOT_VERSION = "2.0.0"
SCHEMA_VERSION = 2
USER_AGENT = "jobwatch/2.0"

EXIT_OK, EXIT_FEED, EXIT_CORRUPT, EXIT_TELEGRAM, EXIT_GATE, EXIT_USAGE = 0, 1, 2, 3, 4, 5

STAGES = ("seen", "applied", "oa", "interview", "offer", "rejected", "dropped")

HEAD_START, HEAD_END = "<!-- JOBS:HEAD:START -->", "<!-- JOBS:HEAD:END -->"
JOBS_START, JOBS_END = "<!-- JOBS:START -->", "<!-- JOBS:END -->"

DEFAULT_CONFIG = {
    "version": 1,
    "feed_url": "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
    "regions": ["US", "TW"],
    "categories": ["Software", "Software Engineering", "AI/ML/Data",
                   "Data Science, AI & Machine Learning", "Quant"],
    "hardware_rescue": {
        "enabled": True,
        "include": ["software", "cuda", "compiler", "kernel", "firmware", "driver", "runtime",
                    "embedded", "gpu architecture", "graphics software"],
        "exclude": ["physical design", "dft", "verification", "validation", "rtl", "asic", "fpga",
                    "analog", "layout", "circuit", "cad", "emulation", "silicon", "signal integrity",
                    "reliability", "technician", "test engineer", "mechanical", "thermal", "optical",
                    "pcb"],
    },
    "title_exclude": ["senior", "sr\\.?", "principal", "director", "manager",
                      "staff\\s+(software|machine learning|ml|ai|data|research|quantitative)?\\s*(engineer|scientist|developer)",
                      "software engineer (2|ii|iii|3)",
                      "operator", "labell?er", "annotator", "technician", "student worker",
                      "data creator", "clerk", "intern", "internship", "co-?op", "pilot", "trainee",
                      "shift"],
    "title_seniority": ["senior", "sr\\.?", "principal", "director", "manager",
                        "staff\\s+(software|machine learning|ml|ai|data|research|quantitative)?\\s*(engineer|scientist|developer)",
                        "software engineer (2|ii|iii|3)"],
    "title_keep": ["new grad", "new college grad", "university grad(uate)?", "graduate", "campus",
                   "early careers?", "entry level"],
    "phd_title": ["ph\\.?\\s?d", "postdoc", "post-doc", "post doc", "doctoral"],
    "research_title": ["research scientist"],
    "bs_ms_degrees": ["Bachelor's", "Master's", "Associate's", "MBA"],
    "deny": ["snap on", "snap finance", "coherent", "primetals", "metalcraft", "metalsa",
             "millennium space systems", "millennium physician", "wolverine world wide",
             "kraken robotics", "upscale ai", "cruise planners"],
    "bad_sponsorship": ["U.S. Citizenship is Required", "Does Not Offer Sponsorship"],
    "max_age_days": 75,
    "archive_days": 180,
    "keep_marks": ["applied", "oa", "interview", "offer", "rejected"],
    "feed": {"min_records": 1000, "min_active": 200, "min_active_ratio": 0.7,
             "required_keys": ["id", "company_name", "title", "active", "category",
                               "date_posted", "locations"]},
    "archive_gate": {"max_closed_fraction": 0.5, "min_prev_active": 20},
    "telegram": {"html": True, "max_lines_per_company": 8, "max_messages_per_run": 4,
                 "pace_seconds": 1.1, "chunk_chars": 3500, "deep_link": True,
                 "deadline_seconds": 180, "quiet_hours": None},
    "readme": {"collapse_over": 20},
    "pages_url": None,
}

# Config keys whose list items are regex fragments (compiled with the bounded wrapper).
FRAGMENT_KEYS = ("hardware_rescue.include", "hardware_rescue.exclude", "title_exclude",
                 "title_seniority", "title_keep", "phd_title", "research_title")

# Seeded into companies.json when the file is absent; edited from the tracker afterwards.
DEFAULT_COMPANIES = sorted({
    # big tech / product / fintech
    "google", "meta", "facebook", "apple", "amazon", "microsoft", "nvidia", "netflix", "linkedin", "uber", "airbnb",
    "snap", "pinterest", "doordash", "roblox", "databricks", "snowflake", "stripe", "coinbase", "adobe", "salesforce",
    "tiktok", "bytedance", "robinhood", "ramp", "figma", "palantir", "bloomberg", "plaid", "brex", "datadog",
    "cloudflare", "mongodb", "confluent", "atlassian", "reddit", "discord", "dropbox", "instacart", "lyft", "kraken",
    "rippling", "carta", "servicenow", "twilio", "okta", "gitlab", "github", "vercel",
    # AI labs
    "openai", "anthropic", "xai", "deepmind", "scale ai", "mistral", "cohere", "perplexity", "safe superintelligence",
    "thinking machines", "anysphere", "cursor", "character ai", "hugging face", "together ai", "fireworks", "baseten",
    "harvey", "glean", "world labs", "elevenlabs", "luma",
    # autonomy / robotics / AI chips
    "zoox", "aurora", "cruise", "wayve", "applied intuition", "motional", "kodiak", "gatik", "waabi", "skild",
    "physical intelligence", "boston dynamics", "figure", "waymo", "tesla", "anduril", "shield ai", "cerebras",
    "sambanova", "groq", "etched", "tenstorrent", "lightmatter", "d-matrix", "rivos",
    # quant / HFT
    "jane street", "citadel", "two sigma", "hudson river", "jump trading", "d e shaw", "optiver", "imc", "akuna", "drw",
    "five rings", "susquehanna", "sig", "virtu", "tower research", "pdt", "point72", "millennium", "balyasny", "aqr",
    "squarepoint", "voleon", "cubist", "worldquant", "xtx", "vatic", "chicago trading", "belvedere", "wolverine", "hrt",
    "radix", "old mission", "headlands", "group one", "peak6", "quantlab", "qube", "bridgewater", "schonfeld", "walleye",
    "exoduspoint", "verition", "flow traders", "geneva trading", "wintermute", "marshall wace", "man group",
})

CAT_TAG = {"Quant": "Quant", "AI/ML/Data": "ML", "Data Science, AI & Machine Learning": "ML",
           "Software": "SWE", "Software Engineering": "SWE", "Hardware": "HW"}

DEGREE_ABBR = (("Bachelor's", "BS"), ("Master's", "MS"), ("PhD", "PhD"))

US_STATES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
    "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY",
    "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
    "WI", "WY", "DC",
}
US_NAMES = {
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware",
    "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky",
    "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
    "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico",
    "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
    "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
    "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia",
}
US_EXACT = {"sf", "south sf", "nyc", "la", "dc", "united states", "usa", "us", "u s", "bay area",
            "washington dc", "washington d c", "san francisco", "new york",
            "san francisco bay area", "silicon valley"}
TW = {"taiwan", "taipei", "new taipei", "hsinchu", "taichung", "tainan", "kaohsiung", "taoyuan"}
NON_US_COUNTRIES = {
    "canada", "uk", "united kingdom", "england", "scotland", "ireland", "germany", "france", "spain",
    "italy", "netherlands", "poland", "switzerland", "sweden", "india", "china", "singapore",
    "japan", "australia", "israel", "mexico", "brazil", "korea", "south korea", "hong kong", "uae",
    "united arab emirates", "europe", "emea", "apac",
}
NON_US_CITIES = {  # city -> ISO-3166 code; "Bangalore, IN" is India, "Vancouver, WA" is the US
    "london": "GB", "toronto": "CA", "vancouver": "CA", "montreal": "CA", "ottawa": "CA",
    "waterloo": "CA", "dublin": "IE", "berlin": "DE", "munich": "DE", "paris": "FR",
    "bangalore": "IN", "bengaluru": "IN", "hyderabad": "IN", "pune": "IN", "mumbai": "IN",
    "chennai": "IN", "gurgaon": "IN", "gurugram": "IN", "noida": "IN", "edinburgh": "GB",
    "amsterdam": "NL", "zurich": "CH", "sydney": "AU", "melbourne": "AU", "tokyo": "JP",
    "seoul": "KR", "shanghai": "CN", "beijing": "CN", "shenzhen": "CN", "tel aviv": "IL",
    "warsaw": "PL", "madrid": "ES", "barcelona": "ES", "stockholm": "SE", "dubai": "AE",
    "singapore": "SG", "hong kong": "HK",
}
REMOTE_US = re.compile(r"^remote( in (usa|us|united states|the us|u s)\b.*)?$")

TELEGRAM_HINTS = {
    401: "HTTP 401 unauthorized — check TELEGRAM_BOT_TOKEN",
    403: "HTTP 403 forbidden — the user blocked the bot or it is not in the chat",
    404: "HTTP 404 — wrong bot token URL (token malformed?)",
}


# ── 1  io ───────────────────────────────────────────────────────────────────

class Abort(Exception):
    """Stop the run with an exit code; nothing has been written when it is raised."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def canonical(obj) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, indent=1) + "\n").encode("utf-8")


def atomic_write(path, data):
    """Write bytes (or utf-8 text) via a same-directory temp file + fsync + os.replace."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".jobwatch-", suffix=".tmp")
    try:
        os.chmod(tmp, 0o666 & ~_umask())  # mkstemp creates 0600; repo files should follow the umask
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _umask() -> int:
    current = os.umask(0)
    os.umask(current)
    return current


def read_bytes(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except FileNotFoundError:
        return None


def read_text(path):
    data = read_bytes(path)
    if data is None:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise Abort(EXIT_CORRUPT, f"{os.path.basename(path)} is not UTF-8") from None


def would_change(path, data: bytes) -> bool:
    return read_bytes(path) != data


def write_if_changed(path, data: bytes) -> bool:
    if not would_change(path, data):
        return False
    atomic_write(path, data)
    return True


def load_json(path, expect, default, lenient=False, warnings=None):
    """Strict on top-level shape: corrupt or wrong type => exit 2, unless lenient (warn, default)."""
    name = os.path.basename(path)
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return default
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        return _corrupt(f"{name} is not valid JSON ({e})", lenient, warnings, default)
    if not isinstance(data, expect):
        return _corrupt(f"{name}: expected a JSON {expect.__name__}, got {type(data).__name__}",
                        lenient, warnings, default)
    return data


def _corrupt(message, lenient, warnings, default):
    if not lenient:
        raise Abort(EXIT_CORRUPT, message)
    if warnings is not None:
        warnings.append(message)
    return default


def blob_sha(data: bytes) -> str:
    """Git's blob object id for these exact bytes (what the Contents API returns as `sha`)."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


# ── 2  config ───────────────────────────────────────────────────────────────

def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_str_list(v):
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


STR_LIST = (_is_str_list, "a list of strings")
OBJECT = (dict.__instancecheck__, "an object")
BOOL = (lambda v: isinstance(v, bool), "true or false")
POS_INT = (lambda v: _is_int(v) and v > 0, "an int > 0")
NONNEG_INT = (lambda v: _is_int(v) and v >= 0, "an int >= 0")

CONFIG_TYPES = {  # dotted key -> (predicate, description); the JS validateConfig mirrors this table
    "version": (_is_int, "an int"),
    "feed_url": (lambda v: isinstance(v, str) and v.startswith("https://"), "a string starting with https://"),
    "regions": (lambda v: _is_str_list(v) and set(v) <= {"US", "TW"}, "a list drawn from [\"US\", \"TW\"]"),
    "categories": STR_LIST, "title_exclude": STR_LIST, "title_seniority": STR_LIST, "title_keep": STR_LIST,
    "phd_title": STR_LIST, "research_title": STR_LIST, "bs_ms_degrees": STR_LIST, "deny": STR_LIST,
    "bad_sponsorship": STR_LIST, "keep_marks": STR_LIST,
    "hardware_rescue": OBJECT, "hardware_rescue.enabled": BOOL,
    "hardware_rescue.include": STR_LIST, "hardware_rescue.exclude": STR_LIST,
    "max_age_days": POS_INT, "archive_days": POS_INT,
    "feed": OBJECT, "feed.min_records": NONNEG_INT, "feed.min_active": NONNEG_INT, "feed.required_keys": STR_LIST,
    "feed.min_active_ratio": (lambda v: _is_num(v) and 0 <= v <= 1, "a number in [0, 1]"),
    "archive_gate": OBJECT, "archive_gate.min_prev_active": (_is_int, "an int"),
    "archive_gate.max_closed_fraction": (lambda v: _is_num(v) and 0 < v <= 1, "a number in (0, 1]"),
    "telegram": OBJECT, "telegram.html": BOOL, "telegram.deep_link": BOOL, "telegram.max_lines_per_company": POS_INT,
    "telegram.max_messages_per_run": POS_INT, "telegram.chunk_chars": POS_INT,
    "telegram.pace_seconds": (lambda v: _is_num(v) and v >= 0, "a number >= 0"),
    "telegram.deadline_seconds": (lambda v: _is_num(v) and v > 0, "a number > 0"),
    "telegram.quiet_hours": (lambda v: v is None or isinstance(v, dict), "null or {start, end, tz}"),
    "readme": OBJECT, "readme.collapse_over": NONNEG_INT,
    "pages_url": (lambda v: v is None or isinstance(v, str), "a string or null"),
}


class Config:
    """Merged, validated config plus the compiled patterns the matcher uses.

    `cfg.regions`, `cfg.deny`, `cfg.feed["min_records"]`, ... read the merged dict.
    """

    def __init__(self, data):
        self.data = data
        hw = data["hardware_rescue"]
        self.hw_include = AnyFragment(hw["include"])
        self.hw_exclude = AnyFragment(hw["exclude"])
        self.title_patterns = [(f, fragment(f)) for f in data["title_exclude"]]
        self.seniority = set(data["title_seniority"])
        self.keep_pattern = AnyFragment(data["title_keep"])
        self.phd_pattern = AnyFragment(data["phd_title"])
        self.research_pattern = AnyFragment(data["research_title"])

    def __getattr__(self, key):
        try:
            return self.__dict__["data"][key]
        except KeyError:
            raise AttributeError(key) from None


def load_config(path):
    """Return (Config, info) where info = {source, sha, warnings}. Missing file => defaults."""
    raw = read_bytes(path)
    if raw is None:
        return Config(copy.deepcopy(DEFAULT_CONFIG)), {"source": "defaults", "sha": None, "warnings": []}
    try:
        user = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise Abort(EXIT_CORRUPT, f"config.json is not valid JSON ({e})") from None
    if not isinstance(user, dict):
        raise Abort(EXIT_CORRUPT, "config.json: expected a JSON object at top level")
    warnings = []
    merged = merge_config(user, warnings)
    validate_config(merged)
    warnings += apply_fragment_fallbacks(merged)
    warnings += apply_quiet_hours_fallback(merged)
    check_seniority_subset(merged)
    return Config(merged), {"source": "config.json", "sha": blob_sha(raw), "warnings": warnings}


def merge_config(user, warnings):
    """Top-level key by key: a list or object in the file replaces the default.

    An object that omits a sub-key gets it from the default, with a warning: the page's validateConfig accepts partial
    objects, and a file the page (or a hand edit) accepted must not stall every run until it is completed.
    """
    merged = copy.deepcopy(DEFAULT_CONFIG)
    for key, value in user.items():
        if key not in DEFAULT_CONFIG:
            warnings.append(f"config.json: unknown key {key!r} ignored")
            continue
        default = DEFAULT_CONFIG[key]
        if isinstance(default, dict) and isinstance(value, dict):
            missing = [sub for sub in default if sub not in value]
            if missing:
                warnings.append(f"config.json: {key} is missing {', '.join(missing)} — filled from defaults")
            value = {**default, **value}
        merged[key] = copy.deepcopy(value)
    return merged


def _config_items(merged):
    """Yield (dotted key, value) for every known key, including nested object members."""
    for key, default in DEFAULT_CONFIG.items():
        value = merged[key]
        yield key, value
        if isinstance(default, dict) and isinstance(value, dict):
            for sub, subvalue in value.items():
                yield f"{key}.{sub}", subvalue


def validate_config(merged):
    for dotted, value in _config_items(merged):
        if dotted not in CONFIG_TYPES:
            continue  # unknown nested key: passes through, harmless
        check, description = CONFIG_TYPES[dotted]
        if not check(value):
            raise Abort(EXIT_CORRUPT, f"config.json: {dotted} must be {description}")


def apply_fragment_fallbacks(merged):
    """A fragment list the matcher cannot use sends its whole key back to the default (§5.3)."""
    warnings = []
    for dotted in FRAGMENT_KEYS:
        *parents, key = dotted.split(".")
        node, default = merged, DEFAULT_CONFIG
        for part in parents:
            node, default = node[part], default[part]
        problem = fragment_problem(node[key], dotted)
        if problem:
            warnings.append(f"config.json: {problem} — using default")
            node[key] = list(default[key])
    return warnings


def fragment_problem(frags, dotted):
    """Why the matcher cannot use this fragment list, or None.

    Each fragment is checked alone, exactly as Config compiles it (AnyFragment) and as lib.js badFragment does; an empty
    one is refused because it would match between any two non-alphanumerics.
    """
    for i, frag in enumerate(frags):
        if not frag.strip():
            return f"{dotted}[{i}] is empty"
        if not compiles(fragment, frag):
            return f"{dotted}[{i}] does not compile"
    return None


def compiles(make_pattern, arg) -> bool:
    try:
        make_pattern(arg)
        return True
    except (re.error, OverflowError, RecursionError):
        # re.compile reports an oversized repetition count as OverflowError and very deep nesting as RecursionError;
        # for §5.3 both mean "does not compile", not an internal error.
        return False


def apply_quiet_hours_fallback(merged):
    q = merged["telegram"]["quiet_hours"]
    if q is None:
        return []
    required = ("start", "end", "tz")
    ok = (set(required) <= set(q) and all(_is_int(q[k]) and 0 <= q[k] <= 23 for k in ("start", "end"))
          and isinstance(q["tz"], str))
    if not ok:
        raise Abort(EXIT_CORRUPT, "config.json: telegram.quiet_hours must be null or {start: 0-23, end: 0-23, tz: IANA name}")
    try:
        ZoneInfo(q["tz"])
    except (ZoneInfoNotFoundError, ValueError):
        merged["telegram"]["quiet_hours"] = None
        return [f"config.json: telegram.quiet_hours.tz {q['tz']!r} is unknown — quiet hours off"]
    merged["telegram"]["quiet_hours"] = {k: q[k] for k in required}
    return [f"config.json: telegram.quiet_hours: unknown key {k!r} ignored" for k in sorted(set(q) - set(required))]


def check_seniority_subset(merged):
    for frag in merged["title_seniority"]:
        if frag not in merged["title_exclude"]:
            raise Abort(EXIT_CORRUPT, f"config.json: title_seniority fragment {frag!r} is not in title_exclude")


# ── 3  text / normalise   (pure) ────────────────────────────────────────────

_NON_ALNUM = re.compile(r"[^a-z0-9 ]")
_SPACES = re.compile(r"\s+")


def norm(s) -> str:
    return _SPACES.sub(" ", _NON_ALNUM.sub(" ", (s or "").lower())).strip()


def strip_parens(title) -> str:
    return re.sub(r"\([^()]*\)", "", title or "")


def group_key(company, title) -> str:
    return norm(company) + "|" + norm(strip_parens(title))


def iso_date(ts) -> str:
    try:
        return time.strftime("%Y-%m-%d", time.gmtime(ts)) if ts else ""
    except (TypeError, ValueError, OverflowError, OSError):
        return ""  # one absurd timestamp in the feed must not stall every run


@functools.cache
def bounded(phrase: str):
    """Literal phrase, word-bounded, for use on norm()-ed text."""
    return re.compile(r"(?<![a-z0-9])" + re.escape(phrase) + r"(?![a-z0-9])")


@functools.cache
def fragment(frag: str):
    """Config regex fragment wrapped as (?<![a-z0-9])(?:FRAG)(?![a-z0-9]), case-insensitive."""
    return re.compile(r"(?<![a-z0-9])(?:" + frag + r")(?![a-z0-9])", re.IGNORECASE)


class AnyFragment:
    """A fragment list matched one pattern at a time, so every fragment keeps the meaning it has alone.

    Joining the list into one alternation would silently renumber a backreference placed after another capturing
    fragment and let a stray `)(` inside one fragment swallow its neighbours; the lists are short, so no join is needed.
    """

    __slots__ = ("patterns",)

    def __init__(self, frags):
        self.patterns = [fragment(f) for f in frags]

    def search(self, text):
        for pattern in self.patterns:
            m = pattern.search(text)
            if m:
                return m
        return None


def degree_tag(degrees) -> str:
    have = set(degrees or [])
    return "/".join(abbr for name, abbr in DEGREE_ABBR if name in have)


def is_http_url(url) -> bool:
    return isinstance(url, str) and url.startswith(("http://", "https://"))


def parse_marks(raw):
    """Lenient status.json reader: {id: Mark|Tombstone} with only known keys, junk dropped.

    Shared with the page through the `parse_marks` table in tests/fixtures/vectors.json.
    """
    out = {}
    for rid, entry in (raw or {}).items():
        if isinstance(entry, str):
            entry = {"s": entry}
        if not isinstance(entry, dict):
            continue
        mark = {}
        if entry.get("s") in STAGES:
            mark["s"] = entry["s"]
        if entry.get("star") is True:
            mark["star"] = True
        if isinstance(entry.get("note"), str) and entry["note"].strip():
            mark["note"] = entry["note"].strip()
        if not mark:
            if _is_num(entry.get("d")):
                out[rid] = {"d": entry["d"]}
            continue
        if _is_num(entry.get("t")):
            mark["t"] = entry["t"]
        history = [h for h in entry.get("h") or [] if isinstance(h, dict)
                   and h.get("s") in STAGES and (h.get("t") is None or _is_num(h.get("t")))]
        if history:
            mark["h"] = [{"s": h["s"], "t": h.get("t")} for h in history[-12:]]
        out[rid] = mark
    return out


# ── 4  matching   (pure) ────────────────────────────────────────────────────

@functools.cache
def _deny_patterns(deny: tuple):
    return [bounded(norm(d)) for d in deny if norm(d)]


def is_denied(normalised_name, deny) -> bool:
    return any(p.search(normalised_name) for p in _deny_patterns(tuple(deny)))


def first_keyword(normalised_name, keywords):
    for k in keywords:
        if bounded(k).search(normalised_name):
            return k
    return None


def match_company(name, keywords, deny):
    """First keyword (sorted, normalised) word-bounded in norm(name), unless a deny phrase hits."""
    n = norm(name)
    if is_denied(n, deny):
        return None
    return first_keyword(n, keywords)


def category_tag(cat, title, cfg):
    if cat in cfg.categories:
        return CAT_TAG.get(cat, "SWE")
    if (cat == "Hardware" and cfg.hardware_rescue["enabled"]
            and cfg.hw_include.search(title) and not cfg.hw_exclude.search(title)):
        return "HW"
    return None


def phd_excluded(degrees, title, cfg) -> bool:
    d = set(degrees or [])
    if cfg.phd_pattern.search(title):
        return True  # explicit PhD in the title beats the degrees field
    if d:
        return "PhD" in d and not (d & set(cfg.bs_ms_degrees))
    return bool(cfg.research_pattern.search(title))


def title_excluded(title, cfg) -> bool:
    hits = [frag for frag, pattern in cfg.title_patterns if pattern.search(title)]
    if not hits:
        return False
    if any(frag not in cfg.seniority for frag in hits):
        return True  # role-type excludes are never waived
    return not cfg.keep_pattern.search(title)


def _to_int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def normalize_record(rec):
    """Feed record -> role dict, or None when the record has no usable id."""
    rid = rec.get("id")
    if not isinstance(rid, str) or not rid:
        return None
    return {
        "id": "simplify:" + rid,
        "company": str(rec.get("company_name") or "").strip(),
        "title": str(rec.get("title") or "").strip(),
        "locations": [x for x in (rec.get("locations") or []) if isinstance(x, str)],
        "category": rec.get("category") or "",
        "url": str(rec.get("url") or ""),
        "sponsorship": rec.get("sponsorship") or "",
        "date_posted": _to_int(rec.get("date_posted")),
        "degrees": [d for d in (rec.get("degrees") or []) if isinstance(d, str)],
        "date_updated": rec.get("date_updated"),
    }


def classify(role, cfg, known_ids, now):
    """§6 order. Returns None (match) or the reject reason; sets role["tag"] on match."""
    tag = category_tag(role["category"], role["title"], cfg)
    if not tag:
        return "category"
    if phd_excluded(role["degrees"], role["title"], cfg):
        return "phd"
    if title_excluded(role["title"], cfg):
        return "title"
    if not region_ok(role["locations"], cfg):
        return "region"
    if role["sponsorship"] in cfg.bad_sponsorship:
        return "sponsorship"
    if role["id"] not in known_ids and now - role["date_posted"] > cfg.max_age_days * 86400:
        return "age"  # sticky once tracked: age never applies to a known id
    role["tag"] = tag
    return None


# ── 5  region   (pure) ──────────────────────────────────────────────────────

def loc_region(s) -> str:
    low = norm(s)
    parts = [p.strip() for p in (s or "").split(",")]
    np = [norm(p) for p in parts]
    if not low:
        return "other"
    if low in TW or any(p in TW for p in np):
        return "TW"
    if low.startswith("remote"):
        return "US" if REMOTE_US.match(low) else "other"
    if low in US_EXACT or low in US_NAMES or any(p in US_EXACT or p in US_NAMES for p in np):
        return "US"  # explicit US beats everything ("Canada, United States")
    if any(p in NON_US_COUNTRIES for p in np):
        return "other"  # a country name anywhere is decisive
    if len(parts) >= 2 and parts[-1] in US_STATES:
        # a trailing state code is decisive unless a foreign city's own country code equals it
        return "other" if any(NON_US_CITIES.get(p) == parts[-1] for p in np) else "US"
    if any(p in NON_US_CITIES for p in np):
        return "other"
    if any(p in US_STATES for p in parts):
        return "US"
    return "other"


def role_region(locations) -> str:
    regions = {loc_region(x) for x in locations}
    for r in ("US", "TW", "other"):
        if r in regions:
            return r
    return "unknown"


def region_ok(locations, cfg) -> bool:
    if not locations or not cfg.regions:
        return True
    return any(loc_region(x) in cfg.regions for x in locations)


# ── 6  feed fetch + gates ───────────────────────────────────────────────────

class Runtime:
    """Clock, environment, network and logging — the only things tests need to fake."""

    def __init__(self, now=None, env=None, urlopen=None, sleep=None, monotonic=None):
        self.now = time.time() if now is None else now
        self.env = os.environ if env is None else env
        self.urlopen = urlopen or urllib.request.urlopen
        self.sleep = sleep or time.sleep
        self.monotonic = monotonic or time.monotonic

    @property
    def in_actions(self) -> bool:
        return bool(self.env.get("GITHUB_ACTIONS"))

    def info(self, msg):
        print(f"[info] {msg}", file=sys.stderr)

    def warn(self, msg):
        self._emit("warning", "warn", msg)

    def error(self, msg):
        self._emit("error", "error", msg)

    def notice(self, msg):
        self._emit("notice", "info", msg)

    def _emit(self, annotation, level, msg):
        """GitHub annotation on stdout inside Actions, a plain [level] line on stderr elsewhere."""
        if self.in_actions:
            print(f"::{annotation}::{msg}")
        else:
            print(f"[{level}] {msg}", file=sys.stderr)


def read_all(url, timeout, deadline, rt) -> bytes:
    remaining = deadline - rt.monotonic()
    if remaining <= 0:
        raise TimeoutError("feed deadline reached")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with rt.urlopen(req, timeout=min(timeout, remaining)) as resp:
        return resp.read()


def fetch_feed(url, rt):
    """4 attempts, [0, 2, 8, 30] s apart (429: Retry-After ≤ 60 s), 150 s total. Returns (raw, attempts)."""
    delays = [0, 2, 8, 30]
    deadline = rt.monotonic() + 150
    retry_after = None
    last_error = "no attempt made"
    for attempt in range(1, 5):
        rt.sleep(retry_after if retry_after is not None else delays[attempt - 1])
        retry_after = None
        try:
            return json.loads(read_all(url, 60, deadline, rt).decode("utf-8")), attempt
        except urllib.error.HTTPError as e:
            if e.code in (404, 410):
                raise Abort(EXIT_FEED, f"feed: URL gone (HTTP {e.code}) — Simplify moved the file; set feed_url in config.json") from None
            if e.code == 429:
                retry_after = min(_int_header(_header(e, "Retry-After"), 30), 60)
            last_error = f"HTTP {e.code}"
        except (OSError, http.client.HTTPException, ValueError) as e:  # URLError, timeout, bad JSON/utf-8
            last_error = str(e) or type(e).__name__
    raise Abort(EXIT_FEED, f"feed: fetch failed after 4 attempts: {last_error}")


def _int_header(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _header(error, name):
    return error.headers.get(name) if error.headers is not None else None


def load_feed(source, rt):
    """`source` is a URL (network, retries) or a local file path (--feed). Returns (raw, attempts)."""
    if is_http_url(source):
        return fetch_feed(source, rt)
    data = read_bytes(source)
    if data is None:
        raise Abort(EXIT_FEED, f"feed: file not found: {source}")
    try:
        return json.loads(data.decode("utf-8")), 1
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise Abort(EXIT_FEED, f"feed: {source} is not valid JSON ({e})") from None


def gate_feed(raw, cfg, meta_prev, force):
    """Degenerate-feed gates (§7.3). Returns the live records."""
    feed = cfg.feed
    if not isinstance(raw, list):
        raise Abort(EXIT_FEED, "feed: not a list (schema drift?)")
    if len(raw) < feed["min_records"]:
        raise Abort(EXIT_FEED, f"feed: {len(raw)} records (< {feed['min_records']})")
    live = [r for r in raw if isinstance(r, dict) and r.get("active") and r.get("is_visible", True)]
    if len(live) < feed["min_active"]:
        raise Abort(EXIT_FEED, f"feed: {len(live)} active records (< {feed['min_active']})")
    feed_prev = meta_prev.get("feed")
    prev_live = _to_int(feed_prev.get("active")) if isinstance(feed_prev, dict) else 0  # meta.json is lenient (§7.2)
    if prev_live and len(live) < feed["min_active_ratio"] * prev_live and not force:
        raise Abort(EXIT_FEED, f"feed: {len(live)} active records < {feed['min_active_ratio']:.0%} of last run's "
                               f"{prev_live} — truncated feed? force=true to accept")
    sample = live[:200]
    for key in feed["required_keys"]:
        if sum(key in r for r in sample) < 0.9 * len(sample):
            raise Abort(EXIT_FEED, f"feed: records lack key {key!r} (schema drift)")
    return live


# ── 7  roles model   (pure) ─────────────────────────────────────────────────

def has_keep_mark(marks, rid, keep_marks) -> bool:
    m = marks.get(rid)
    if not isinstance(m, dict):
        return False
    return m.get("s") in keep_marks or bool(m.get("star")) or bool(m.get("note"))


def role_row(role, prev_row, now):
    """The active row for a matched role: prev row updated in place, or a fresh one."""
    row = dict(prev_row) if prev_row else {"id": role["id"], "first_seen": int(now)}
    row.update({
        "company": role["company"],
        "title": role["title"],
        "location": ", ".join(role["locations"][:3]) or "location N/A",
        "url": role["url"],
        "category": role["tag"],
        "posted": iso_date(role["date_posted"]),
        "date_posted": role["date_posted"],
        "active": True,
        "locations": list(role["locations"]),
        "region": role_region(role["locations"]),
        "degrees": list(role["degrees"]),
        "sponsorship": role["sponsorship"],
        "group": group_key(role["company"], role["title"]),
        "in_feed": True,
        "reason": None,
    })
    row.pop("closed_at", None)  # reactivation clears clocks and hints; last_seen stays frozen
    row.pop("why", None)
    return row


def archived_row(row, live_role, why, now):
    """A previously known row that does not match now: close it once, then only track in_feed."""
    row = dict(row)
    in_feed = live_role is not None
    was_active = bool(row.get("active"))
    if in_feed:  # still listed: keep what the page shows about it current (§5.1 example C)
        row.update(location=", ".join(live_role["locations"][:3]) or "location N/A", locations=list(live_role["locations"]),
                   region=role_region(live_role["locations"]), degrees=list(live_role["degrees"]),
                   sponsorship=live_role["sponsorship"])
    if was_active or "closed_at" not in row:
        row["active"] = False
        row["in_feed"] = in_feed
        if was_active:
            row["closed_at"] = int(now)
            row["last_seen"] = int(now)
        else:  # legacy archived row: derive the clock, keep its float last_seen as-is
            row["closed_at"] = int(row.get("last_seen") or row.get("date_posted") or now)
        _set_reason(row, in_feed, why)
    elif row.get("in_feed") != in_feed:
        row["in_feed"] = in_feed
        _set_reason(row, in_feed, why)
    row["group"] = row.get("group") or group_key(row.get("company", ""), row.get("title", ""))
    row["posted"] = iso_date(row.get("date_posted"))
    return row


def _set_reason(row, in_feed, why):
    row["reason"] = "untracked" if in_feed else "closed"
    if in_feed and why:
        row["why"] = why
    else:
        row.pop("why", None)


def row_sort_key(row):
    return (0 if row.get("active") else 1, -(row.get("date_posted") or 0),
            (row.get("company") or "").lower(), (row.get("title") or "").lower(), row["id"])


def apply_roles_model(prev, matched, live, why, marks, cfg, now, marks_unreliable=False):
    """§7.4.1: prev rows + this run's matches -> the new roles.json rows (sorted, pruned).

    `live` maps every live feed id to its normalised record (tracked or not).
    """
    rows = [role_row(role, prev.get(rid), now) for rid, role in matched.items()]
    horizon = cfg.archive_days * 86400
    for rid, row in prev.items():
        if rid in matched:
            continue
        row = archived_row(row, live.get(rid), why.get(rid), now)
        keep = marks_unreliable or has_keep_mark(marks, rid, cfg.keep_marks)
        clock = row.get("closed_at") or row.get("last_seen") or row.get("date_posted") or now
        if not keep and now - clock > horizon:
            continue
        rows.append(row)
    return sorted(rows, key=row_sort_key)


# ── 8  outputs: roles / README / meta ───────────────────────────────────────

def one_line(s) -> str:
    return " ".join((s or "").split())


def md_text(s) -> str:
    """Feed text as one markdown line: newlines collapsed, link/table/HTML delimiters neutralised (the feed is public)."""
    return one_line(s).replace("[", "(").replace("]", ")").replace("|", "/").replace("<", "&lt;").replace(">", "&gt;")


def md_url(url) -> str:
    return urllib.parse.quote(url, safe=":/?#[]@!$&'*+,;=%-._~")


def active_groups(rows):
    """Active rows -> {company: [[rows of one group, newest first], ...]} ordered for display."""
    by_company = defaultdict(lambda: defaultdict(list))
    for row in rows:
        if row.get("active"):
            by_company[row["company"]][row.get("group") or group_key(row["company"], row["title"])].append(row)
    out = {}
    for company in sorted(by_company, key=lambda c: (-sum(len(g) for g in by_company[c].values()), c.lower())):
        groups = [sorted(g, key=lambda r: (-r["date_posted"], r["id"])) for g in by_company[company].values()]
        out[company] = sorted(groups, key=lambda g: (-g[0]["date_posted"], g[0]["title"].lower()))
    return out


def group_locations(group):
    seen, labels = set(), []
    for row in group:
        label = row.get("location") or "location N/A"
        if label not in seen:
            seen.add(label)
            labels.append(label)
    return labels


def group_degrees(group):
    return degree_tag({d for row in group for d in row.get("degrees") or []})


def render_jobs_list(rows, cfg) -> str:
    lines = []
    for company, groups in active_groups(rows).items():
        count = sum(len(g) for g in groups)
        opened = " open" if count <= cfg.readme["collapse_over"] else ""
        lines += [f"<details{opened}>", f"<summary>{html.escape(one_line(company))} ({count})</summary>", ""]
        for group in groups:
            newest = group[0]
            title = md_text(newest["title"])
            links = [f"[{title}]({md_url(newest['url'])})" if is_http_url(newest["url"]) else title]
            links += [f"[{i}]({md_url(r['url'])})" for i, r in enumerate(group[1:], 2) if is_http_url(r["url"])]
            parts = [" · ".join(links) + " — " + "; ".join(md_text(label) for label in group_locations(group)),
                     f"posted {iso_date(newest['date_posted'])}", newest["category"]]
            if group_degrees(group):
                parts.append(group_degrees(group))
            lines.append("- " + " · ".join(parts))
        lines += ["", "</details>"]
    return "\n".join(lines) + "\n"


def render_head_line(rows, pages_url, last_change, existing_link=None) -> str:
    counts = Counter(r["company"] for r in rows if r.get("active"))
    n = sum(counts.values())
    summary = f"_{n} open new-grad roles at {len(counts)} companies"
    if last_change:
        summary += f" · list last changed {iso_date(last_change)}"
    parts = [summary + " · scans every ~2 h_"]
    link = pages_url or existing_link
    if link:
        parts.append(f"**[Open the tracker]({link})**")
    parts.append("[Full list ↓](#current-roles)")
    top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].lower()))
    parts += [f"{md_text(company)} {count}" for company, count in top[:8]]
    if len(top) > 8:
        parts.append("…")
    return " · ".join(parts)


def _between(text, start, end):
    """(before, inside, after) for the first marker pair, or None when either marker is absent."""
    i = text.find(start)
    j = text.find(end, i + len(start)) if i >= 0 else -1
    if i < 0 or j < 0:
        return None
    return text[:i + len(start)], text[i + len(start):j], text[j:]


def render_readme(text, rows, cfg, pages_url, last_change) -> str:
    text = text or "# jobwatch\n"
    head = _between(text, HEAD_START, HEAD_END)
    if head:
        before, inside, after = head
        m = re.search(r"\*\*\[Open the tracker\]\((\S+?)\)\*\*", inside)
        line = render_head_line(rows, pages_url, last_change, m.group(1) if m else None)
        text = f"{before}\n{line}\n{after}"
    body = "\n" + render_jobs_list(rows, cfg)
    jobs = _between(text, JOBS_START, JOBS_END)
    if jobs:
        before, _, after = jobs
        return before + body + after
    return text.rstrip("\n") + f"\n\n## Current roles\n\n{JOBS_START}{body}{JOBS_END}\n"


def parse_remote(url):
    """'https://github.com/o/r.git' or 'git@github.com:o/r.git' -> (owner, repo) or None."""
    m = re.match(r"^(?:https?://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/\s]+)/([^/\s]+?)(?:\.git)?/?$",
                 (url or "").strip())
    return (m.group(1), m.group(2)) if m else None


def derive_pages_url(repo) -> str:
    owner, name = repo.split("/", 1)
    if name.lower() == f"{owner.lower()}.github.io":
        return f"https://{owner.lower()}.github.io/"
    return f"https://{owner.lower()}.github.io/{name}/"


def git_output(args, cwd):
    try:
        return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=10,
                              check=True).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def repo_identity(cfg, env, state_dir):
    """(repo 'owner/name' | None, branch | None, pages_url | None) from env, then git, then config."""
    repo = env.get("GITHUB_REPOSITORY") or None
    if not repo:
        parsed = parse_remote(git_output(["remote", "get-url", "origin"], state_dir))
        repo = "/".join(parsed) if parsed else None
    branch = env.get("GITHUB_REF_NAME") or git_output(["rev-parse", "--abbrev-ref", "HEAD"], state_dir)
    pages = cfg.pages_url or (derive_pages_url(repo) if repo else None)
    return repo, branch, pages


def keyword_stats(plan, rows, keywords):
    """meta.keywords: active/all_time/names/denied per normalised keyword (all_time ignores deny)."""
    all_time = Counter(first_keyword(norm(r.get("company", "")), keywords) for r in rows)
    out = {}
    for kw in keywords:
        st = plan.kw_stats[kw]
        out[kw] = {"active": st["active"], "all_time": all_time.get(kw, 0),
                   "names": sorted(st["names"])[:5], "denied": st["denied"]}
    return out


def build_meta(plan, delivery, state, cfg, rt, result, identity, roles_changed):
    repo, branch, pages = identity
    rows = plan.rows
    active = [r for r in rows if r.get("active")]
    inactive = [r for r in rows if not r.get("active")]
    prev = state.meta
    return {
        "version": SCHEMA_VERSION,
        "bot_version": BOT_VERSION,
        "repo": repo,
        "branch": branch,
        "pages_url": pages,
        "last_run": int(rt.now),
        "last_change": int(rt.now) if roles_changed else prev.get("last_change"),
        "last_result": result,
        "feed": plan.feed_info,
        "counts": {
            "active": len(active),
            "closed": sum(1 for r in inactive if r.get("reason") == "closed"),
            "untracked": sum(1 for r in inactive if r.get("reason") == "untracked"),
            "groups": len({r["group"] for r in active}),
            "companies": len({r["company"] for r in active}),
            "new_this_run": len(plan.new_ids),
            "silent_known_this_run": len(plan.known_silent),
            "closed_this_run": len(plan.newly_closed),
            "untracked_this_run": len(plan.untracked_now),
        },
        "rejects": {k: plan.rejects.get(k, 0) for k in ("category", "phd", "title", "region", "sponsorship", "age")},
        "keywords": keyword_stats(plan, rows, plan.keywords),
        "telegram": {"mode": delivery.mode, "delivered": len(delivery.delivered),
                     "failed_chunks": len(delivery.failed), "creds": delivery.creds},
        "config_source": state.cfg_info["source"],
        "config_sha": state.cfg_info["sha"],
        "warnings": list(state.warnings) + list(plan.warnings),
    }


def planned_writes(plan, delivery, state, cfg, paths, rt, identity):
    """Phase E decided without side effects: (name, path, bytes) for every file this run would write, in write order.

    The dry run prints these names and the real run writes them, so the preview cannot drift from the writes (§7.9).
    """
    roles = canonical(plan.rows)
    roles_changed = would_change(paths.roles, roles)
    last_change = int(rt.now) if roles_changed else state.meta.get("last_change")
    readme = render_readme(state.readme, plan.rows, cfg, identity[2], last_change).encode("utf-8")
    outputs = [("roles.json", paths.roles, roles), ("README.md", paths.readme, readme)]
    if delivery.seen_out is not None:
        outputs.append(("seen.json", paths.seen, canonical(delivery.seen_out)))
    writes = [(n, p, b) for n, p, b in outputs if would_change(p, b)]
    if state.companies is None:
        writes.append(("companies.json", paths.companies, canonical(DEFAULT_COMPANIES)))
    result = delivery.result() or ("ok" if roles_changed else "ok-no-change")
    meta = build_meta(plan, delivery, state, cfg, rt, result, identity, roles_changed)
    if meta_due(meta, state.meta, result, {n for n, _, _ in writes}, rt.now):
        writes.append(("meta.json", paths.meta, canonical(meta)))
    return writes


def meta_due(meta, prev, result, changed, now):
    """§7.6: meta.json is written when another output changed, the result is not ok, as a ~daily heartbeat, or to
    acknowledge a config/keyword edit that changed no match (config-stale banner, Companies dialog counts)."""
    return (bool(changed) or result not in ("ok", "ok-no-change") or now - prev.get("last_run", 0) > 20 * 3600
            or meta["config_sha"] != prev.get("config_sha") or set(meta["keywords"]) != set(prev.get("keywords") or {}))


def write_outputs(plan, delivery, state, cfg, paths, rt, args, identity):
    """Phase E — the only writes of the run. Returns the set of file names that changed."""
    writes = planned_writes(plan, delivery, state, cfg, paths, rt, identity)
    if args.dry_run:
        print("[dry-run] would write: " + (", ".join(n for n, _, _ in writes) or "nothing"))
        return set()
    changed = {n for n, p, b in writes if write_if_changed(p, b)}
    if "companies.json" in changed:
        rt.notice("seeded companies.json")
    return changed


# ── 9  telegram ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Chunk:
    html: str
    plain: str
    ids: frozenset


@dataclass
class Unit:
    """One rendered line of a digest; `kind` drives spacing, `ids` the seen.json accounting."""
    kind: str  # company | bullet | fold | tail | note
    html: str
    plain: str
    ids: frozenset = frozenset()


def esc(s) -> str:
    return html.escape(str(s), quote=True)


def link(url, text) -> str:
    return f'<a href="{esc(url)}">{esc(text)}</a>' if is_http_url(url) else esc(text)


def company_units(company, groups, kw, cfg, pages_url):
    n_ids = sum(len(g) for g in groups)
    units = [Unit("company", f"<b>{esc(company)}</b> ({n_ids})", f"{company} ({n_ids})")]
    shown = groups[:cfg.telegram["max_lines_per_company"]]
    for group in shown:
        units.append(bullet_unit(company, group))
    folded = [r for g in groups[len(shown):] for r in g]
    if folded:
        text = f"+{len(folded)} more at {company}"
        deep = f"{pages_url}#f=new&co={urllib.parse.quote(kw)}" if pages_url else None
        units.append(Unit("fold", f"… {link(deep, text) if deep else esc(text)} in the tracker",
                          f"… {text} in the tracker" + (f"\n   {deep}" if deep else ""),
                          frozenset(r["id"] for r in folded)))
    return units


def bullet_unit(company, group):
    newest = group[0]
    counts = Counter(r.get("location") or "location N/A" for r in group)
    first_url = {}
    for r in group:
        first_url.setdefault(r.get("location") or "location N/A", r["url"])
    locs = " · ".join(link(first_url[label], label) + (f" ×{n}" if n > 1 else "") for label, n in counts.items())
    sponsors = "sponsors" if any(r.get("sponsorship") == "Offers Sponsorship" for r in group) else ""
    suffix = f" ({len(group)} postings)" if len(group) > 1 else ""
    suffix += "".join(f" · {t}" for t in (group_degrees(group), sponsors) if t)
    html_line = f"• [{newest['category']}] {link(newest['url'], newest['title'])} — {locs}{suffix}"
    plain = f"[{newest['category']}] {company} — {newest['title']} — {'; '.join(counts)}{suffix}"
    plain += "".join(f"\n   {r['url']}" for r in group if r.get("url"))
    return Unit("bullet", html_line, plain, frozenset(r["id"] for r in group))


def pack_units(blocks, limit):
    """Whole company blocks when possible, else whole bullets (header repeated), never mid-line."""
    chunks, current, size = [], [], 0

    def flush():
        nonlocal current, size
        if current:
            chunks.append(current)
        current, size = [], 0

    for block in blocks:
        block_size = sum(len(u.html) + 1 for u in block) + 1
        if current and size + block_size > limit:
            flush()
        if block_size <= limit:
            current += block
            size += block_size
            continue
        header, lines = block[0], block[1:]
        current.append(header)
        size += len(header.html) + 2
        for unit in lines:
            if len(current) > 1 and size + len(unit.html) + 1 > limit:
                flush()
                current, size = [header], len(header.html) + 2
            current.append(unit)
            size += len(unit.html) + 1
    flush()
    return chunks


def digest_chunks(new_roles, cfg, pages_url, newly_tracked=(), untracked_note=None):
    """§8.1 digest as ≤ max_messages_per_run chunks. Ids cut by the cap belong to no chunk."""
    tg = cfg.telegram
    pages = pages_url if tg["deep_link"] else None
    by_company = active_groups(new_roles)
    kw_of = {r["company"]: r["kw"] for r in new_roles}
    total = len(new_roles)
    top = sorted(((c, sum(len(g) for g in gs)) for c, gs in by_company.items()), key=lambda x: (-x[1], x[0].lower()))
    head_html = f"<b>{total} new roles</b>" + "".join(f" · {esc(c)} {n}" for c, n in top[:4])
    head_plain = f"{total} new roles" + "".join(f" · {c} {n}" for c, n in top[:4])
    fresh = Counter(r["kw"] for r in new_roles if r["kw"] in set(newly_tracked))
    if fresh:
        note = " · incl. newly tracked: " + ", ".join(f"{k} ({n})" for k, n in sorted(fresh.items()))
        head_html += esc(note)
        head_plain += note
    tracker_html = f'<a href="{esc(pages)}#f=new">Open the tracker → New</a>' if pages else ""
    tracker_plain = f"{pages}#f=new" if pages else ""

    blocks = [company_units(c, gs, kw_of[c], cfg, pages) for c, gs in by_company.items()]
    limit = tg["chunk_chars"] - len(head_html) - len(tracker_html) - 160
    packed = pack_units(blocks, max(limit, 200))
    cap = tg["max_messages_per_run"]
    if len(packed) > cap:
        cut = sum(len(u.ids) for chunk in packed[cap:] for u in chunk)
        packed = packed[:cap]
        more = f"+{cut} more roles — open the tracker"
        packed[-1].append(Unit("tail", link(f"{pages}#f=new", more) if pages else esc(more),
                               more + (f": {pages}#f=new" if pages else "")))
    if untracked_note:
        packed[-1].append(Unit("note", esc(untracked_note), untracked_note))
    return [finish_chunk(units, i, len(packed), head_html, head_plain, tracker_html, tracker_plain)
            for i, units in enumerate(packed)]


def finish_chunk(units, index, total, head_html, head_plain, tracker_html, tracker_plain):
    part = f" (part {index + 1}/{total})" if total > 1 else ""
    html_lines = [head_html + part] + ([tracker_html] if tracker_html and index == 0 else [])
    plain_lines = [head_plain + part] + ([tracker_plain] if tracker_plain and index == 0 else [])
    ids = set()
    for unit in units:
        if unit.kind in ("company", "tail", "note"):
            html_lines.append("")
            plain_lines.append("")
        html_lines.append(unit.html)
        plain_lines.append(unit.plain)
        ids |= unit.ids
    return Chunk("\n".join(html_lines), "\n".join(plain_lines), frozenset(ids))


def summary_chunks(rows, pages_url):
    """§8.2 first-run summary; ids = every active role (seeded only if the message is accepted)."""
    active = [r for r in rows if r.get("active")]
    counts = Counter(r["company"] for r in active)
    companies = " · ".join(f"{c} {n}" for c, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].lower())))
    intro = (f" Watching {len(active)} open new-grad roles at {len(counts)} companies. "
             f"New postings arrive here; the README lists everything.")
    html_text = f"<b>jobwatch is live.</b>{esc(intro)}"
    plain = "jobwatch is live." + intro
    if pages_url:
        html_text += f'\n<a href="{esc(pages_url)}">Open the tracker</a>'
        plain += f"\n{pages_url}"
    return [Chunk(f"{html_text}\n\n{esc(companies)}", f"{plain}\n\n{companies}", frozenset(r["id"] for r in active))]


def plain_chunk(text) -> Chunk:
    return Chunk("", text, frozenset())


def in_quiet_hours(now, q) -> bool:
    if not q:
        return False
    hour = datetime.fromtimestamp(now, ZoneInfo(q["tz"])).hour
    start, end = q["start"], q["end"]
    if start == end:
        return False
    if start < end:
        return start <= hour < end
    return hour >= start or hour < end


def _sleep_within(rt, seconds, deadline) -> bool:
    if rt.monotonic() + seconds > deadline:
        return False
    rt.sleep(seconds)
    return True


def _telegram_error(e):
    try:
        body = json.loads(e.read().decode("utf-8"))
        return str(body.get("description") or ""), body.get("parameters") or {}
    except (ValueError, AttributeError, OSError):
        return "", {}


def send_telegram(chunk, creds, deadline, rt):
    """POST sendMessage. Returns (ok, error). HTML 400 => one plain retry; 429/5xx bounded by deadline."""
    token, chat = creds
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    text, parse_mode = (chunk.html, "HTML") if chunk.html else (chunk.plain, None)
    retries_429 = transient = 0
    while True:
        if rt.monotonic() >= deadline:
            return False, "delivery deadline reached"
        fields = {"chat_id": chat, "text": text, "disable_web_page_preview": "true"}
        if parse_mode:
            fields["parse_mode"] = parse_mode
        req = urllib.request.Request(url, data=urllib.parse.urlencode(fields).encode())
        try:
            with rt.urlopen(req, timeout=30) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            description, params = _telegram_error(e)
            if e.code == 400:
                if parse_mode:
                    text, parse_mode = chunk.plain, None  # HTML rejected: retry once as plain text
                    continue
                hint = " — did you message the bot first?" if "chat not found" in description else ""
                return False, f"HTTP 400 {description}{hint}".rstrip()
            if e.code == 429:
                retries_429 += 1
                if retries_429 > 3:
                    return False, "HTTP 429 after 3 retries"
                wait = min(_int_header(params.get("retry_after"), _int_header(_header(e, "Retry-After"), 5)), 60)
                if not _sleep_within(rt, wait, deadline):
                    return False, "HTTP 429 — delivery deadline reached"
                continue
            if e.code in TELEGRAM_HINTS:
                return False, TELEGRAM_HINTS[e.code]
            error = f"HTTP {e.code} {description}".rstrip()
        except (OSError, http.client.HTTPException, ValueError) as e:
            error = str(e) or type(e).__name__
        else:
            if body.get("ok"):
                return True, None
            return False, f"ok:false {body.get('description', '')}".rstrip()
        transient += 1
        if transient > 2:
            return False, f"{error} after 2 retries"
        if not _sleep_within(rt, (2, 6)[transient - 1], deadline):
            return False, f"{error} — delivery deadline reached"


@dataclass
class Delivery:
    mode: str
    chunks: list
    delivered: set = field(default_factory=set)
    failed: list = field(default_factory=list)  # (index, error, chunk)
    seen_out: list = None  # seen.json after this run, None = leave it alone; under --dry-run: what a real run would write
    creds: bool = False

    def result(self):
        return {"failed": "telegram-failed", "partial": "telegram-partial"}.get(self.mode)


def delivery_mode(no_notify, chunks, has_creds, quiet_hours, now):
    """The §7.5 branch a real run takes; the dry run rehearses it so its would-write list matches the real run."""
    if no_notify:
        return "no_notify"
    if not chunks:
        return "none"
    if not has_creds:
        return "no_creds"
    if in_quiet_hours(now, quiet_hours):
        return "quiet"
    return "sent"


def deliver(plan, cfg, args, rt, state, pages_url):
    """Phase D (§7.5). Telegram is the only side effect before the write phase."""
    creds = (rt.env.get("TELEGRAM_BOT_TOKEN"), rt.env.get("TELEGRAM_CHAT_ID"))
    has_creds = all(creds)
    if plan.first_run:
        chunks = summary_chunks(plan.rows, pages_url)
    else:
        chunks = digest_chunks(plan.new_roles, cfg, pages_url, plan.newly_tracked, plan.untracked_note) if plan.new_roles else []
    q = cfg.telegram["quiet_hours"]
    mode = delivery_mode(args.no_notify, chunks, has_creds, q, rt.now)
    all_ids = set().union(*(c.ids for c in chunks)) if chunks else set()
    opted_out = all_ids if plan.first_run else set(plan.new_ids)  # --no-notify also marks the ids cut by the message cap
    if args.dry_run:
        print(f"[dry-run] would send {len(chunks)} chunk(s)")
        for c in chunks:
            print(c.plain)
        # Rehearse the real run's accounting with every chunk accepted, so the would-write list is truthful about seen.json.
        accepted = {"sent": all_ids, "no_notify": opted_out}.get(mode, set())
        return Delivery(mode="dry_run", chunks=chunks, creds=has_creds, seen_out=seen_after(plan, mode, accepted, state))
    d = Delivery(mode=mode, chunks=chunks, creds=has_creds)
    if mode == "no_notify":
        d.delivered = opted_out
    elif mode == "no_creds":
        print(f"[warn] No Telegram creds: {len(all_ids)} new role(s) printed below and NOT marked seen — they will be "
              f"announced once TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID exist. Use --no-notify to mark them seen without alerts.")
        for c in chunks:
            print(c.plain)
    elif mode == "quiet":
        rt.info(f"quiet hours ({q['start']}–{q['end']} {q['tz']}): {len(chunks)} chunk(s) held — "
                f"sent by the first run after {q['end']}:00")
    elif mode == "sent":
        send_chunks(d, chunks, creds, cfg, rt)
    if plan.untracked_note and has_creds and d.mode == "none":
        send_telegram(plain_chunk(plan.untracked_note), creds, rt.monotonic() + 30, rt)
    d.seen_out = seen_after(plan, d.mode, d.delivered, state)
    return d


def send_chunks(d, chunks, creds, cfg, rt):
    tg = cfg.telegram
    deadline = rt.monotonic() + tg["deadline_seconds"]
    for i, c in enumerate(chunks):
        if rt.monotonic() >= deadline:
            d.failed.append((i, "delivery deadline reached", c))
            continue
        if i:
            rt.sleep(tg["pace_seconds"])
        ok, err = send_telegram(c, creds, deadline, rt)
        if ok:
            d.delivered |= c.ids
        else:
            d.failed.append((i, err, c))
    d.mode = "sent" if not d.failed else ("failed" if len(d.failed) == len(chunks) else "partial")
    n = len(chunks)
    if d.mode == "sent":
        print(f"[telegram] sent {n}/{n} chunks ({len(d.delivered)} roles)")
    for i, err, c in d.failed:
        rt.warn(f"telegram chunk {i + 1}/{n} failed: {err} — {len(c.ids)} role(s) will be re-announced next run")
        print(c.plain)
    if d.mode == "failed":
        errors = dict.fromkeys(err for _, err, _ in d.failed)  # distinct, first-seen order: the root cause leads
        rt.error(f"telegram: all {n} chunks failed: {'; '.join(errors)}")


def seen_after(plan, mode, delivered, state):
    """seen.json after a run in `mode` that delivered `delivered`, or None to leave the file alone (§5.5, §7.5)."""
    if plan.first_run:
        return sorted(plan.matched) if mode in ("sent", "no_notify") else None
    return sorted(set(state.seen) | delivered | plan.known_silent)


# ── 10  run() ───────────────────────────────────────────────────────────────

class Paths:
    """Where the state files live: `paths.roles`, `.seen`, `.status`, `.companies`, `.meta`, `.readme`, `.config`."""

    FILES = {"roles": "roles.json", "seen": "seen.json", "status": "status.json", "companies": "companies.json",
             "meta": "meta.json", "readme": "README.md"}

    def __init__(self, state_dir, config=None):
        self.state_dir = state_dir
        self.config = config or os.path.join(state_dir, "config.json")
        for attr, name in self.FILES.items():
            setattr(self, attr, os.path.join(state_dir, name))


@dataclass
class State:
    cfg: Config
    cfg_info: dict
    roles: list
    companies: list  # None when the file is absent (seeded in the write phase)
    seen: list       # None when the file is absent (first run)
    marks: dict
    marks_unreliable: bool
    meta: dict
    readme: str  # None when absent; decoded in Phase A so a non-UTF-8 README fails before Telegram, not before seen.json
    warnings: list


@dataclass
class Plan:
    rows: list
    matched: dict
    new_roles: list
    new_ids: list
    known_silent: set
    prev_active: set
    newly_closed: list
    untracked_now: list
    first_run: bool
    rejects: Counter
    kw_stats: dict
    keywords: list
    newly_tracked: list
    untracked_note: str
    feed_info: dict
    tracked: list  # (role, kw, reason|None) for --verbose
    warnings: list


def load_state(paths):
    """Phase A — read and validate every state file; nothing is written."""
    cfg, cfg_info = load_config(paths.config)
    warnings = list(cfg_info["warnings"])
    companies = load_json(paths.companies, list, None)
    if companies is not None and not all(isinstance(x, str) for x in companies):
        raise Abort(EXIT_CORRUPT, "companies.json must be a list of strings")
    roles = load_json(paths.roles, list, [])
    validate_roles(roles)
    seen = load_json(paths.seen, list, None)
    if seen is not None and not all(isinstance(x, str) for x in seen):
        raise Abort(EXIT_CORRUPT, "seen.json is corrupt — fix it or delete it to reset")
    status_warnings = []
    status = load_json(paths.status, dict, None, lenient=True, warnings=status_warnings)
    marks_unreliable = bool(status_warnings)
    if marks_unreliable:
        warnings.append(status_warnings[0] + " — pruning disabled this run")
    meta = load_json(paths.meta, dict, {}, lenient=True, warnings=warnings)
    readme = read_text(paths.readme)
    return State(cfg, cfg_info, roles, companies, seen, parse_marks(status or {}), marks_unreliable, meta, readme, warnings)


def validate_roles(roles):
    """roles.json rows need unique string ids and numeric clocks; a hand-edited row fails here, not deep in the model."""
    ids = [r.get("id") for r in roles if isinstance(r, dict)]
    if len(ids) != len(roles) or not all(isinstance(i, str) and i for i in ids):
        raise Abort(EXIT_CORRUPT, "roles.json is corrupt (every row needs a string id) — fix or restore it from git")
    if len(set(ids)) != len(ids):
        dup = next(i for i, n in Counter(ids).items() if n > 1)
        raise Abort(EXIT_CORRUPT, f"roles.json has duplicate id {dup!r} — fix or restore it from git")
    for row in roles:
        for key in ("date_posted", "first_seen", "last_seen", "closed_at"):
            if row.get(key) is not None and not _is_num(row[key]):
                raise Abort(EXIT_CORRUPT, f"roles.json: row {row['id']!r} has a non-numeric {key} — fix or restore it from git")


def keyword_list(companies, warnings):
    if companies is None:
        companies = DEFAULT_COMPANIES
    elif not companies:
        warnings.append("companies.json is [] — tracking nothing; every role becomes 'untracked'")
    if any(norm(x) == "" for x in companies):
        warnings.append("companies.json: an entry normalises to '' and is ignored")
    return sorted({norm(x) for x in companies} - {""})


def build_plan(state, live, feed_info, cfg, now, force):
    """Phase C — pure matching + roles model + gates (exit 4 raised here, before any write)."""
    warnings = []
    keywords = keyword_list(state.companies, warnings)
    prev = {r["id"]: r for r in state.roles}
    live_roles, matched, why, tracked = {}, {}, {}, []
    rejects = Counter()
    kw_stats = defaultdict(lambda: {"active": 0, "names": set(), "denied": 0})
    for rec in live:
        role = normalize_record(rec)
        if role is None:
            continue
        live_roles[role["id"]] = role
        n = norm(role["company"])
        kw = match_company(role["company"], keywords, cfg.deny)
        if kw is None:
            if is_denied(n, cfg.deny):
                for k in keywords:
                    if bounded(k).search(n):
                        kw_stats[k]["denied"] += 1
            continue
        reason = classify(role, cfg, prev, now)
        tracked.append((role, kw, reason))
        if reason:
            rejects[reason] += 1
            why[role["id"]] = reason
            continue
        role["kw"] = kw
        matched[role["id"]] = role
        kw_stats[kw]["active"] += 1
        kw_stats[kw]["names"].add(role["company"])
    prev_active = {i for i, r in prev.items() if r.get("active")}
    for i in set(prev) & set(live_roles):
        if i not in matched and i not in why:
            why[i] = "company"  # live, previously known, no classifier reason: its company stopped matching
    marks = {} if state.marks_unreliable else state.marks
    rows = apply_roles_model(prev, matched, live_roles, why, marks, cfg, now, state.marks_unreliable)

    newly_closed = [i for i in prev_active if i not in matched and i not in live_roles]
    untracked_now = [i for i in prev_active if i not in matched and i in live_roles]
    gate = cfg.archive_gate
    if prev_active and not matched and not force and state.companies != []:
        raise Abort(EXIT_GATE, f"0 matches while {len(prev_active)} roles were active and {len(keywords)} keywords "
                               f"are configured — pass --force / force=true if intended")
    if (len(prev_active) >= gate["min_prev_active"]
            and len(newly_closed) > gate["max_closed_fraction"] * len(prev_active) and not force):
        raise Abort(EXIT_GATE, f"{len(newly_closed)}/{len(prev_active)} active roles would close in one run; "
                               f"force=true if real")
    untracked_note = None
    if len(untracked_now) > 0.5 * len(prev_active):
        untracked_note = f"Note: {len(untracked_now)} roles left your filters this run (settings or company list changed?)"
        warnings.append(f"{len(untracked_now)} roles left your filters this run (config/companies change?)")

    first_run = state.seen is None or state.seen == []
    seen = set(state.seen or [])
    known_silent = set() if first_run else {
        i for i in matched if i not in seen and i in prev and (not prev[i].get("active") or i in marks)}
    new_ids = [] if first_run else [i for i in matched if i not in seen and i not in known_silent]
    rows_by_id = {r["id"]: r for r in rows}
    new_roles = [dict(rows_by_id[i], kw=matched[i]["kw"]) for i in new_ids]
    prev_keywords = state.meta.get("keywords") or {}
    newly_tracked = [k for k in keywords if k not in prev_keywords] if prev_keywords else []
    return Plan(rows, matched, new_roles, new_ids, known_silent, prev_active, newly_closed, untracked_now,
                first_run, rejects, kw_stats, keywords, newly_tracked, untracked_note, feed_info, tracked, warnings)


def print_verbose(plan, state):
    seen = set(state.seen or [])
    for role, kw, reason in sorted(plan.tracked, key=lambda t: (t[1], t[0]["company"], t[0]["title"])):
        flag = reason or ("MATCH " + ("first-run" if plan.first_run else "seen" if role["id"] in seen
                                     else "silent" if role["id"] in plan.known_silent else "NEW"))
        updated = iso_date(role.get("date_updated"))
        print(f"[verbose] {flag:<14} {role['company']} | {role['title']} | {'; '.join(role['locations'])} | "
              f"{'/'.join(role['degrees']) or 'no degrees'} | updated {updated}")


def summary_line(plan, delivery, code):
    active = sum(1 for r in plan.rows if r.get("active"))
    gate = f"{100 * len(plan.newly_closed) / len(plan.prev_active):.1f} %" if plan.prev_active else "n/a"
    return (f"{active} active · +{len(plan.new_ids)} new ({delivery.mode}) · {len(plan.known_silent)} known silent · "
            f"{len(plan.untracked_now)} untracked · {len(plan.newly_closed)} closed · archive gate {gate} · "
            f"{len(delivery.chunks)} chunk(s) · exit {code}")


def step_summary(rt, plan, delivery, changed, code):
    path = rt.env.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    active = sum(1 for r in plan.rows if r.get("active"))
    lines = [f"**jobwatch** exit {code} · {active} active roles",
             f"- new: {len(plan.new_ids)} ({delivery.mode}) · known silent: {len(plan.known_silent)}",
             f"- untracked this run: {len(plan.untracked_now)} · closed this run: {len(plan.newly_closed)}",
             f"- feed: {plan.feed_info['records']} records / {plan.feed_info['active']} active",
             f"- files changed: {', '.join(sorted(changed)) or 'none'}"]
    with open(path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def run(args, rt) -> int:
    """Phases A–E. Everything before the write phase is read-only on disk."""
    paths = Paths(args.state_dir, args.config)
    state = load_state(paths)
    cfg = state.cfg
    for w in state.warnings:
        rt.warn(w)
    force = args.force or rt.env.get("JOBWATCH_FORCE") == "1"
    raw, attempts = load_feed(args.feed or cfg.feed_url, rt)
    live = gate_feed(raw, cfg, state.meta, force)
    feed_info = {"records": len(raw), "active": len(live), "fetched_at": int(rt.now), "attempts": attempts}
    plan = build_plan(state, live, feed_info, cfg, rt.now, force)
    for w in plan.warnings:
        rt.warn(w)
    if args.verbose:
        print_verbose(plan, state)
    identity = repo_identity(cfg, rt.env, paths.state_dir)
    delivery = deliver(plan, cfg, args, rt, state, identity[2])
    changed = write_outputs(plan, delivery, state, cfg, paths, rt, args, identity)
    code = EXIT_TELEGRAM if delivery.mode == "failed" else EXIT_OK
    print(("[dry-run] " if args.dry_run else "[ok] ") + summary_line(plan, delivery, code))
    step_summary(rt, plan, delivery, changed, code)
    return code


# ── 11  CLI ─────────────────────────────────────────────────────────────────

class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        print(f"[error] {message}", file=sys.stderr)
        raise SystemExit(EXIT_USAGE)


def parse_args(argv):
    p = Parser(prog="jobwatch", description="Watch the Simplify new-grad feed for roles at your companies.")
    p.add_argument("--dry-run", action="store_true", help="full pipeline incl. gates; write nothing, send nothing")
    p.add_argument("--feed", metavar="FILE|URL", help="feed snapshot instead of the network")
    p.add_argument("--no-notify", action="store_true", help="skip Telegram and mark new roles seen")
    p.add_argument("--verbose", action="store_true", help="per-record reasons at tracked companies")
    p.add_argument("--state-dir", default=".", metavar="DIR", help="directory holding the state files")
    p.add_argument("--config", metavar="PATH", help="config file (default <state-dir>/config.json)")
    p.add_argument("--force", action="store_true", help="bypass the archive and zero-match gates once")
    p.add_argument("--explain", nargs=2, metavar=("COMPANY", "TITLE"), help="run the classifier on one synthetic role")
    p.add_argument("--degrees", default="", help='with --explain: "PhD,Master\'s"')
    p.add_argument("--locations", default="", help='with --explain: "SF;NYC"')
    p.add_argument("--version", action="store_true", help="print the bot version")
    return p.parse_args(argv)


def explain(args, cfg, keywords) -> int:
    company, title = args.explain
    degrees = [d.strip() for d in args.degrees.split(",") if d.strip()]
    locations = [x.strip() for x in args.locations.split(";") if x.strip()]
    n = norm(company)
    kw = match_company(company, keywords, cfg.deny)
    if is_denied(n, cfg.deny):
        company_line = f"denied by {[d for d in cfg.deny if bounded(norm(d)).search(n)]}"
    else:
        company_line = f"keyword {kw!r}" if kw else "no keyword matches"
    checks = [
        ("company", kw is not None, company_line),
        ("category", True, "not checked for a synthetic role (feed category unknown)"),
        ("phd", not phd_excluded(degrees, title, cfg), f"degrees={degrees or 'none'}"),
        ("title", not title_excluded(title, cfg), "title excludes with the new-grad override"),
        ("region", region_ok(locations, cfg), ", ".join(f"{x} → {loc_region(x)}" for x in locations) or "no locations (passes)"),
    ]
    for name, ok, detail in checks:
        print(f"{'pass' if ok else 'FAIL':<5} {name:<9} {detail}")
    verdict = all(ok for _, ok, _ in checks)
    print("verdict: would match" if verdict else "verdict: would NOT match")
    return EXIT_OK


def ops_alert(exc, rt):
    """§7.8: one plain line to Telegram before exit 2/4 on a local run with creds. Inside Actions the workflow's
    notify step is the single sender (it quotes the ::error:: line and links the run), so this stands down there."""
    creds = (rt.env.get("TELEGRAM_BOT_TOKEN"), rt.env.get("TELEGRAM_CHAT_ID"))
    if rt.in_actions or exc.code not in (EXIT_CORRUPT, EXIT_GATE) or not all(creds):
        return
    url = rt.env.get("GITHUB_RUN_URL") or "local run"
    send_telegram(plain_chunk(f"jobwatch: {exc.message}. Run: {url}"), creds, rt.monotonic() + 30, rt)


def main(argv=None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    rt = Runtime()
    if args.version:
        print(f"jobwatch {BOT_VERSION}")
        return EXIT_OK
    if not os.path.isdir(args.state_dir):
        rt.error(f"--state-dir {args.state_dir!r} is not a directory")
        return EXIT_USAGE
    try:
        if args.explain:
            paths = Paths(args.state_dir, args.config)
            cfg, _ = load_config(paths.config)
            companies = load_json(paths.companies, list, None)
            return explain(args, cfg, keyword_list(companies, []))
        return run(args, rt)
    except Abort as e:
        return fail(e, args, rt)
    except Exception as e:  # not BaseException: argparse's SystemExit(5) and KeyboardInterrupt must pass through
        traceback.print_exc()
        # Exit 2, never a bare 1: the workflow files exit 1 under the feed-failure debounce and waits for the
        # "::error::feed:" streak a traceback never prints, so a crash repeating every run would go unreported.
        return fail(Abort(EXIT_CORRUPT, f"internal error: {type(e).__name__}: {str(e)[:200]} — a bug or a hand-edited "
                                        "state file (traceback above)"), args, rt)


def fail(exc, args, rt) -> int:
    rt.error(exc.message)
    if not args.dry_run:
        ops_alert(exc, rt)
    return exc.code


if __name__ == "__main__":
    sys.exit(main())
