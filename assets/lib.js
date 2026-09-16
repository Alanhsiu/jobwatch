/**
 * jobwatch tracker — pure helpers (no window/document/fetch/localStorage).
 *
 * Everything here is a function of its inputs, so `node --test 'tests/js/*.test.mjs'` covers it without a DOM.
 * `norm()` and `groupKey()` mirror jobwatch.py byte-for-byte (spec §6.1, §6.8) and are pinned by the shared
 * vector table tests/fixtures/vectors.json; a change in one language without the other fails CI.
 */

/** Integer page version. Bump together with every `?v=` in index.html/app.js/sync.js and `data-app` (§2 Q2). */
export const APP_VERSION = 2;

/** Pipeline stages in UI order. "todo" is the default and is never stored in status.json. */
export const STAGES = Object.freeze(["todo", "seen", "applied", "oa", "interview", "offer", "rejected", "dropped"]);

/** Human labels for `STAGES`. */
export const STAGE_LABEL = Object.freeze({
  todo: "To review", seen: "Seen", applied: "Applied", oa: "OA", interview: "Interviewing",
  offer: "Offer", rejected: "Rejected", dropped: "Dismissed",
});

/** "Most advanced" ordering used for group rows: offer > interview > oa > applied > rejected > seen > dropped > todo. */
export const STAGE_RANK = Object.freeze({offer: 7, interview: 6, oa: 5, applied: 4, rejected: 3, seen: 2, dropped: 1, todo: 0});

/** Stages that exempt a role from the bot's 180-day prune (plus any star or note). Mirrors `config.keep_marks`. */
export const KEEP_STAGES = Object.freeze(["applied", "oa", "interview", "offer", "rejected"]);

/** Category display/sort order. `HW` (Hardware rescue) is new in v2 and sorts last. */
export const CAT_ORDER = Object.freeze({Quant: 0, ML: 1, SWE: 2, HW: 3});

/**
 * Mirror of jobwatch.py `DEFAULT_CONFIG` (§5.3): Settings prefill and the `validateConfig` type table.
 * Deep-frozen — copy before editing.
 */
export const DEFAULT_CONFIG = deepFreeze({
  version: 1,
  feed_url: "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
  regions: ["US", "TW"],
  categories: ["Software", "Software Engineering", "AI/ML/Data", "Data Science, AI & Machine Learning", "Quant"],
  hardware_rescue: {
    enabled: true,
    include: ["software", "cuda", "compiler", "kernel", "firmware", "driver", "runtime", "embedded",
      "gpu architecture", "graphics software"],
    exclude: ["physical design", "dft", "verification", "validation", "rtl", "asic", "fpga", "analog", "layout",
      "circuit", "cad", "emulation", "silicon", "signal integrity", "reliability", "technician",
      "test engineer", "mechanical", "thermal", "optical", "pcb"],
  },
  title_exclude: ["senior", "sr\\.?", "principal", "director", "manager",
    "staff\\s+(software|machine learning|ml|ai|data|research|quantitative)?\\s*(engineer|scientist|developer)",
    "software engineer (2|ii|iii|3)",
    "operator", "labell?er", "annotator", "technician", "student worker", "data creator", "clerk",
    "intern", "internship", "co-?op", "pilot", "trainee", "shift"],
  title_seniority: ["senior", "sr\\.?", "principal", "director", "manager",
    "staff\\s+(software|machine learning|ml|ai|data|research|quantitative)?\\s*(engineer|scientist|developer)",
    "software engineer (2|ii|iii|3)"],
  title_keep: ["new grad", "new college grad", "university grad(uate)?", "graduate", "campus", "early careers?", "entry level"],
  phd_title: ["ph\\.?\\s?d", "postdoc", "post-doc", "post doc", "doctoral"],
  research_title: ["research scientist"],
  bs_ms_degrees: ["Bachelor's", "Master's", "Associate's", "MBA"],
  deny: ["snap on", "snap finance", "coherent", "primetals", "metalcraft", "metalsa", "millennium space systems",
    "millennium physician", "wolverine world wide", "kraken robotics", "upscale ai", "cruise planners"],
  bad_sponsorship: ["U.S. Citizenship is Required", "Does Not Offer Sponsorship"],
  max_age_days: 75,
  archive_days: 180,
  keep_marks: ["applied", "oa", "interview", "offer", "rejected"],
  feed: {min_records: 1000, min_active: 200, min_active_ratio: 0.7,
    required_keys: ["id", "company_name", "title", "active", "category", "date_posted", "locations"]},
  archive_gate: {max_closed_fraction: 0.5, min_prev_active: 20},
  telegram: {html: true, max_lines_per_company: 8, max_messages_per_run: 4, pace_seconds: 1.1,
    chunk_chars: 3500, deep_link: true, deadline_seconds: 180, quiet_hours: null},
  readme: {collapse_over: 20},
  pages_url: null,
});

const STORED_STAGES = new Set(STAGES.filter((s) => s !== "todo"));
const PIPELINE_STAGES = ["offer", "interview", "oa", "applied"];
const VIEWS = Object.freeze(["inbox", "new", "pipeline", "star", "all", "closed", "untracked",
  "seen", "applied", "oa", "interview", "offer", "rejected", "dropped"]);
const SORTS = Object.freeze(["company", "newest", "oldest", "added", "updated", "closed"]);
const VIEW_DEFAULT_SORT = {new: "added", pipeline: "updated", closed: "closed"};
const HISTORY_CAP = 12;
const TOMBSTONE_TTL_S = 60 * 86400;
const NEW_FLOOR_S = 36 * 3600;
const DEGREE_ABBR = {"Associate's": "AS", "Bachelor's": "BS", "Master's": "MS", MBA: "MBA", PhD: "PhD", MD: "MD"};

/* ------------------------------------------------------------------ text (shared with Python) */

/**
 * Normalise a name exactly like jobwatch.py: lowercase, every char outside [a-z0-9 ] → space, collapse
 * whitespace, strip. `norm("d-Matrix") === "d matrix"`.
 * @param {unknown} s
 * @returns {string}
 */
export function norm(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Display-only group key: `norm(company) + "|" + norm(title without parentheticals)` (§6.8).
 * Roles sharing a key fold into one row; marks stay per id.
 * @param {unknown} company
 * @param {unknown} title
 * @returns {string}
 */
export function groupKey(company, title) {
  return norm(company) + "|" + norm(String(title ?? "").replace(/\([^()]*\)/g, ""));
}

/* ------------------------------------------------------------------ marks: parse / serialise / compare */

/**
 * Lenient reader for status.json / localStorage marks (§5.4). Accepts legacy string entries (`"applied"`),
 * ignores unknown keys and unknown stages, drops entries with none of s/star/note/d. Never invents `t`.
 * @param {unknown} obj raw parsed JSON
 * @returns {Record<string, object>} `{id: Mark | Tombstone}`
 */
export function parseMarks(obj) {
  const out = {};
  if (!isPlainObject(obj)) return out;
  for (const [id, raw] of Object.entries(obj)) {
    const entry = parseEntry(raw);
    if (entry) out[id] = entry;
  }
  return out;
}

function parseEntry(raw) {
  if (typeof raw === "string") return STORED_STAGES.has(raw) ? {s: raw} : null;
  if (!isPlainObject(raw)) return null;
  const e = {};
  if (STORED_STAGES.has(raw.s)) e.s = raw.s;
  if (raw.star) e.star = true;
  if (typeof raw.note === "string" && raw.note.trim()) e.note = raw.note.trim();
  if (isMark(e)) {
    const t = epochOrNull(raw.t);
    if (t) e.t = t;
    const h = parseHistory(raw.h);
    if (h) e.h = h;
    return e;
  }
  const d = epochOrNull(raw.d);
  return d ? {d} : null;
}

function parseHistory(h) {
  if (!Array.isArray(h)) return null;
  const items = [];
  for (const it of h) {
    if (isPlainObject(it) && STORED_STAGES.has(it.s)) items.push({s: it.s, t: epochOrNull(it.t)});
  }
  return items.length ? items.slice(-HISTORY_CAP) : null;
}

function epochOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

/**
 * Canonical writer for status.json / marks.v3: known keys only, ids and entry keys sorted (stable diffs),
 * tombstones older than 60 days dropped. Never mutates its input.
 * @param {Record<string, object>} marks
 * @param {number} nowS epoch seconds
 * @returns {Record<string, object>}
 */
export function serializeMarks(marks, nowS) {
  const out = {};
  const cutoff = nowS - TOMBSTONE_TTL_S;
  for (const id of Object.keys(marks || {}).sort()) {
    const e = marks[id];
    if (isMark(e)) out[id] = canonicalMark(e);
    else if (isTomb(e) && e.d >= cutoff) out[id] = {d: e.d};
  }
  return out;
}

function canonicalMark(e) {
  const out = {};
  if (Array.isArray(e.h) && e.h.length) out.h = e.h.slice(-HISTORY_CAP).map((it) => ({s: it.s, t: it.t ?? null}));
  if (e.note) out.note = e.note;
  if (e.s) out.s = e.s;
  if (e.star) out.star = true;
  if (Number.isFinite(e.t)) out.t = e.t;
  return out;
}

/**
 * LWW timestamp of an entry: `t` for marks, `d` for tombstones, 0 for legacy entries.
 * @param {object|null|undefined} e
 * @returns {number}
 */
export function entryTime(e) {
  if (!e || typeof e !== "object") return 0;
  const ts = e.t ?? e.d;
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * True when the entry carries user state (stage, star or note).
 * @param {unknown} e
 * @returns {boolean}
 */
export function isMark(e) {
  return !!e && typeof e === "object" && (!!e.s || !!e.star || !!e.note);
}

/**
 * True when the entry is a deletion tombstone `{d}` (and not a mark).
 * @param {unknown} e
 * @returns {boolean}
 */
export function isTomb(e) {
  return !!e && typeof e === "object" && !isMark(e) && Number.isFinite(e.d);
}

/**
 * Canonical JSON of the user-visible value `{s, star, note}` — what LWW ties and PUT acks compare.
 * Tombstones give `"{}"`; null/undefined give `""`.
 * @param {object|null|undefined} e
 * @returns {string}
 */
export function valueOf(e) {
  if (!e || typeof e !== "object") return "";
  return JSON.stringify({s: e.s || undefined, star: e.star ? true : undefined, note: e.note || undefined});
}

/* ------------------------------------------------------------------ merge (§10.4.2) */

/**
 * Three-way-free LWW merge of local marks against a remote copy — one branch per row of the §10.4.2 table.
 *
 * `dropped` lists LOCAL entries that lost (removed by case 3, or replaced by a remote value that differs) so the
 * engine can stash them in trash.v1 and record them in its `removed` map; remote losers are not reported
 * (the other device stashes its own). `changedIds` are ids whose merged entry differs from `local[id]`.
 *
 * @param {Record<string, object>} local
 * @param {Record<string, object>} remote
 * @param {Set<string>} dirty ids changed locally and not yet acknowledged by a PUT
 * @param {boolean} remoteAuthoritative HTTP 200 through the Contents API with a parseable object (never the Pages mirror)
 * @returns {{merged: Record<string, object>, changedIds: Set<string>, dropped: Array<{id: string, entry: object, why: "remote-deleted"|"lww-loser"}>}}
 */
export function mergeMarks(local, remote, dirty, remoteAuthoritative) {
  const merged = {};
  const changedIds = new Set();
  const dropped = [];
  const ids = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);
  for (const id of ids) {
    const L = local[id];
    const R = remote[id];
    const isDirty = dirty.has(id);
    let result;
    if (!L) result = R;                                                  // 1
    else if (!R) {
      if (isDirty) result = L;                                            // 2
      else if (remoteAuthoritative) result = undefined;                   // 3
      else result = L;                                                    // 4
    } else result = resolveBoth(L, R, isDirty);                           // 5–8
    if (result !== undefined) merged[id] = result;
    if (!L || !sameEntry(L, result)) changedIds.add(id);
    if (L && (result === undefined || (result !== L && valueOf(result) !== valueOf(L)))) {
      dropped.push({id, entry: L, why: result === undefined ? "remote-deleted" : "lww-loser"});
    }
  }
  return {merged, changedIds, dropped};
}

function resolveBoth(L, R, isDirty) {
  const tl = entryTime(L);
  const tr = entryTime(R);
  if (tl > 0 && tr > 0) {                                                 // 5: newer wins; tie → L if dirty else R
    if (tr > tl) return R;
    if (tl > tr) return L;
    return isDirty ? L : R;
  }
  if (tl > 0 && tr === 0) {                                               // 6: t-less remote (old page rewrote the file)
    if (valueOf(L) === valueOf(R) || isDirty) return L;
    return carryHistory(L, R);
  }
  if (tl === 0 && tr > 0) return R;                                       // 7
  if (valueOf(L) === valueOf(R) || isDirty) return L;                    // 8: both t-less
  return carryHistory(L, R);
}

/** A t-less remote value wins: keep L's stage history so Pipeline does not fall back to "date unknown". */
function carryHistory(L, R) {
  if (!Array.isArray(L.h) || !L.h.length) return R;
  const h = [...L.h];
  if (R.s && h[h.length - 1].s !== R.s) h.push({s: R.s, t: null});
  return {...R, h: h.slice(-HISTORY_CAP)};
}

function sameEntry(a, b) {
  return JSON.stringify(canonicalEntry(a)) === JSON.stringify(canonicalEntry(b));
}

function canonicalEntry(e) {
  if (!e) return null;
  return isMark(e) ? canonicalMark(e) : {d: e.d};
}

/* ------------------------------------------------------------------ views (§10.5, §10.7) */

/**
 * Compute what a view shows. Pure: roles + marks + view state + clock in, rows/sections/counts out.
 *
 * Rows are groups formed from the visible ids only (a 4-id group with 2 applied members shows ×2 in Inbox and
 * ×2 in Applied); single-member groups are plain rows. Row: `{key, id, ids, members[], stage, star, isNew,
 * company, title, newest, added, updated, closed}` where `stage` is the most advanced member stage and `id`
 * the newest posting. Sections are companies (sort `company`), pipeline stages (view `pipeline`, sort
 * `updated`) or one anonymous section otherwise. `counts` holds every view's role count under the current
 * `cat`/`co`/`hc` filters but ignoring the search box, so tab badges match what a tab shows.
 *
 * @param {object[]} roles roles.json rows (+ manual roles)
 * @param {Record<string, object>} marks parsed marks
 * @param {object} view `{f, s, cat[], co, hc, q}` from `hashToView`
 * @param {number} nowS epoch seconds
 * @param {{lastVisitMs?: number|null, metaLastRunS?: number|null}} [opts]
 * @returns {{view: object, rows: object[], sections: Array<{key: string, name: string, rows: object[], count: number}>, counts: Record<string, number>, total: number}}
 */
export function buildView(roles, marks, view, nowS, opts = {}) {
  const v = normalizeView(view);
  const refS = opts.metaLastRunS ?? maxSeenAt(roles);
  const lastVisitMs = opts.lastVisitMs ?? null;
  const coRe = v.co ? boundedRe(v.co) : null;
  const facts = [];
  for (const role of roles || []) {
    if (!role || typeof role.id !== "string") continue;
    if (v.cat.length && !v.cat.includes(role.category)) continue;
    if (coRe && !coRe.test(norm(role.company))) continue;
    facts.push(roleFacts(role, marks[role.id], lastVisitMs, refS));
  }
  const counts = {};
  for (const name of VIEWS) counts[name] = facts.filter((f) => inView(f, name, v.hc)).length;
  const q = v.q.toLowerCase();
  const members = facts.filter((f) => inView(f, v.f, v.hc) && (!q || haystack(f).includes(q)));
  const rows = sortRows(groupRows(members), v.s);
  return {view: v, rows, sections: sectionize(rows, v), counts, total: members.length};
}

function roleFacts(role, entry, lastVisitMs, refS) {
  const marked = isMark(entry);
  return {
    id: role.id, role, entry: marked ? entry : null,
    stage: marked && entry.s ? entry.s : "todo",
    star: marked && !!entry.star,
    hasMark: marked,
    active: role.active !== false,
    inFeed: role.in_feed === true,
    isNew: isNew(role, lastVisitMs, refS),
  };
}

function inView(f, name, hideClosed) {
  switch (name) {
    case "inbox": return f.active && f.stage === "todo";
    case "new": return f.active && f.stage === "todo" && f.isNew;
    case "pipeline": return PIPELINE_STAGES.includes(f.stage);
    case "star": return f.star;
    case "all": return hideClosed ? f.active || f.hasMark : true;
    case "closed": return !f.active && !f.inFeed && f.hasMark;
    case "untracked": return !f.active && f.inFeed;
    default: return f.stage === name;
  }
}

function haystack(f) {
  const r = f.role;
  return [r.company, r.title, ...locationsOf(r), f.entry?.note].filter(Boolean).join(" ").toLowerCase();
}

function groupRows(members) {
  const byKey = new Map();
  for (const f of members) {
    const key = typeof f.role.group === "string" && f.role.group ? f.role.group : groupKey(f.role.company, f.role.title);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(f);
  }
  const rows = [];
  for (const [key, group] of byKey) {
    group.sort((a, b) => num(b.role.date_posted) - num(a.role.date_posted) || cmp(a.id, b.id));
    const primary = group[0].role;
    const times = group.map((f) => f.entry?.t).filter(Number.isFinite);
    rows.push({
      key, id: primary.id, ids: group.map((f) => f.id),
      members: group.map((f) => ({id: f.id, role: f.role, entry: f.entry, stage: f.stage, star: f.star, isNew: f.isNew})),
      stage: mostAdvanced(group.map((f) => f.stage)),
      star: group.some((f) => f.star),
      isNew: group.some((f) => f.isNew),
      company: primary.company, title: primary.title, category: primary.category,
      newest: Math.max(...group.map((f) => num(f.role.date_posted))),
      added: Math.max(...group.map((f) => seenAt(f.role))),
      updated: times.length ? Math.max(...times) : null,
      closed: Math.max(...group.map((f) => num(f.role.closed_at))),
    });
  }
  return rows;
}

function mostAdvanced(stages) {
  return stages.reduce((best, s) => ((STAGE_RANK[s] ?? 0) > (STAGE_RANK[best] ?? 0) ? s : best), "todo");
}

function sortRows(rows, sort) {
  const byCompany = (a, b) => cmp(a.company.toLowerCase(), b.company.toLowerCase());
  const byName = (a, b) => byCompany(a, b) || cmp(a.title.toLowerCase(), b.title.toLowerCase()) || cmp(a.id, b.id);
  const comparators = {
    company: (a, b) => byCompany(a, b) || (CAT_ORDER[a.category] ?? 9) - (CAT_ORDER[b.category] ?? 9)
      || b.newest - a.newest || byName(a, b),
    newest: (a, b) => b.newest - a.newest || byName(a, b),
    oldest: (a, b) => a.newest - b.newest || byName(a, b),
    added: (a, b) => b.added - a.added || b.newest - a.newest || byName(a, b),
    updated: (a, b) => (a.updated === null) - (b.updated === null) || (b.updated ?? 0) - (a.updated ?? 0) || byName(a, b),
    closed: (a, b) => b.closed - a.closed || byName(a, b),
  };
  return rows.sort(comparators[sort] || comparators.company);
}

function sectionize(rows, v) {
  if (v.s === "company") {
    return partition(rows, (row) => row.company, (row) => row.company);
  }
  if (v.f === "pipeline" && v.s === "updated") {
    const sections = partition(rows, (row) => row.stage, (row) => STAGE_LABEL[row.stage]);
    return sections.sort((a, b) => (STAGE_RANK[b.key] ?? 0) - (STAGE_RANK[a.key] ?? 0));
  }
  return rows.length ? [{key: "", name: "", rows, count: rows.reduce((n, r) => n + r.ids.length, 0)}] : [];
}

function partition(rows, keyOf, nameOf) {
  const sections = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!sections.has(key)) sections.set(key, {key, name: nameOf(row), rows: [], count: 0});
    const s = sections.get(key);
    s.rows.push(row);
    s.count += row.ids.length;
  }
  return [...sections.values()];
}

function normalizeView(view) {
  const src = view || {};
  const f = VIEWS.includes(src.f) ? src.f : "inbox";
  const s = SORTS.includes(src.s) ? src.s : defaultSort(f);
  const catSrc = Array.isArray(src.cat) ? src.cat : String(src.cat || "").split(",");
  const cat = Object.keys(CAT_ORDER).filter((c) => catSrc.includes(c));
  return {f, s, cat, co: norm(src.co), hc: src.hc !== false && src.hc !== "0" && src.hc !== 0, q: String(src.q ?? "").trim()};
}

function defaultSort(f) {
  return VIEW_DEFAULT_SORT[f] || "company";
}

/**
 * Hybrid "new" rule (§3 #7): first seen after the previous visit, OR within 36 h of `refS` (the bot's last
 * run, or the newest `first_seen` when meta.json is absent). Manual roles use `added`/`date_posted`.
 * With neither a previous visit nor a reference nothing is new.
 * @param {object} role
 * @param {number|null|undefined} prevLastVisitMs
 * @param {number|null|undefined} refS epoch seconds
 * @returns {boolean}
 */
export function isNew(role, prevLastVisitMs, refS) {
  const seen = seenAt(role);
  if (!seen) return false;
  const byVisit = Number.isFinite(prevLastVisitMs) && seen * 1000 > prevLastVisitMs;
  const byFloor = Number.isFinite(refS) && seen >= refS - NEW_FLOOR_S;
  return byVisit || byFloor;
}

function seenAt(role) {
  return num(role.first_seen) || num(role.added) || num(role.date_posted);
}

function maxSeenAt(roles) {
  let max = 0;
  for (const r of roles || []) max = Math.max(max, seenAt(r || {}));
  return max || null;
}

/* ------------------------------------------------------------------ hash ⇄ view */

/**
 * Parse `#f=inbox&s=company&cat=ML,SWE&co=tiktok&hc=1&q=infra` (or the `#new` alias) into a view object with
 * every field filled: unknown views/sorts/categories fall back to defaults.
 * @param {string} str location.hash (leading `#` optional)
 * @returns {{f: string, s: string, cat: string[], co: string, hc: boolean, q: string}}
 */
export function hashToView(str) {
  let s = String(str ?? "");
  if (s.startsWith("#")) s = s.slice(1);
  if (s === "new") s = "f=new";
  const p = new URLSearchParams(s);
  return normalizeView({f: p.get("f"), s: p.get("s"), cat: p.get("cat") || "", co: p.get("co") || "",
    hc: p.get("hc") !== "0", q: p.get("q") || ""});
}

/**
 * Inverse of `hashToView`: always emits `f`; other keys only when they differ from the view's defaults.
 * @param {object} view
 * @returns {string} e.g. `#f=inbox&cat=ML,SWE&q=infra`
 */
export function viewToHash(view) {
  const v = normalizeView(view);
  const p = new URLSearchParams();
  p.set("f", v.f);
  if (v.s !== defaultSort(v.f)) p.set("s", v.s);
  if (v.cat.length) p.set("cat", v.cat.join(","));
  if (v.co) p.set("co", v.co);
  if (!v.hc) p.set("hc", "0");
  if (v.q) p.set("q", v.q);
  return "#" + p.toString().replace(/%2C/gi, ",");
}

/* ------------------------------------------------------------------ dates and small formatters */

/**
 * Relative age: "today" (< 1 day), "3d ago" (< 14 d), then whole weeks ("2w ago").
 * @param {number} ts epoch seconds
 * @param {number} nowS epoch seconds
 * @returns {string} "" for invalid input
 */
export function rel(ts, nowS) {
  if (!Number.isFinite(ts) || !Number.isFinite(nowS)) return "";
  const days = Math.floor((nowS - ts) / 86400);
  if (days <= 0) return "today";
  if (days < 14) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/**
 * UTC calendar date `YYYY-MM-DD` of an epoch-seconds timestamp (matches Python `iso_date`: a missing or zero
 * timestamp is "no date").
 * @param {number} ts
 * @returns {string} "" for invalid, zero or negative input
 */
export function isoDate(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  try {
    return new Date(ts * 1000).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

/**
 * Location list of a role: v2 `locations[]` when present, else the legacy `location` string as a single item
 * (it is not reversibly splittable — never fabricated).
 * @param {object} role
 * @returns {string[]}
 */
export function locationsOf(role) {
  if (Array.isArray(role?.locations) && role.locations.length) return role.locations.filter((x) => typeof x === "string" && x);
  return typeof role?.location === "string" && role.location ? [role.location] : [];
}

/**
 * "BS/MS/PhD"-style tag from the feed's `degrees` list; unknown names ignored; "" when empty.
 * @param {unknown} degrees
 * @returns {string}
 */
export function degreeTag(degrees) {
  if (!Array.isArray(degrees)) return "";
  return Object.keys(DEGREE_ABBR).filter((d) => degrees.includes(d)).map((d) => DEGREE_ABBR[d]).join("/");
}

/**
 * RFC 4180 CSV (CRLF, quotes doubled, fields with `,` `"` or newlines quoted). Columns default to the first
 * row's keys; null/undefined print as empty. A string cell that a spreadsheet would evaluate as a formula
 * (leading `=` `+` `-` `@` tab or CR — feed titles and notes are third-party text) is prefixed with `'`, which
 * Excel/LibreOffice/Sheets hide; numbers are left alone.
 * @param {object[]} rows
 * @param {string[]} [columns]
 * @returns {string}
 */
export function toCSV(rows, columns) {
  const cols = columns ?? (rows.length ? Object.keys(rows[0]) : []);
  const cell = (v) => {
    let s = v == null ? "" : String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols, ...rows.map((r) => cols.map((c) => r[c]))];
  return lines.map((line) => line.map(cell).join(",")).join("\r\n") + "\r\n";
}

/* ------------------------------------------------------------------ config validation (§5.3 type table) */

const FRAGMENT_KEYS = new Set(["title_exclude", "title_seniority", "title_keep", "phd_title", "research_title"]);
const CONFIG_SCHEMA = {
  version: "int",
  feed_url: "https_url",
  regions: "regions",
  categories: "strlist",
  hardware_rescue: {enabled: "bool", include: "fraglist", exclude: "fraglist"},
  title_exclude: "fraglist",
  title_seniority: "fraglist",
  title_keep: "fraglist",
  phd_title: "fraglist",
  research_title: "fraglist",
  bs_ms_degrees: "strlist",
  deny: "strlist",
  bad_sponsorship: "strlist",
  max_age_days: "posint",
  archive_days: "posint",
  keep_marks: "strlist",
  feed: {min_records: "nonneg_int", min_active: "nonneg_int", min_active_ratio: "unit", required_keys: "strlist"},
  archive_gate: {max_closed_fraction: "fraction", min_prev_active: "int"},
  telegram: {html: "bool", max_lines_per_company: "posint", max_messages_per_run: "posint", pace_seconds: "nonneg_num",
    chunk_chars: "posint", deep_link: "bool", deadline_seconds: "posnum", quiet_hours: "quiet_hours"},
  readme: {collapse_over: "nonneg_int"},
  pages_url: "str_or_null",
};

/**
 * Validate a config.json object against the §5.3 type table; regex fragments are compiled with the same
 * bounded wrapper Python uses. Unknown keys are reported as warnings (Python ignores them with a warning).
 * A nested object may omit keys of its default: `merge_config` fills them in with a warning, so this reports the
 * same key list as a warning, never an error — Settings may save `{"feed": {"min_records": 500}}` and the bot runs.
 * `tests/fixtures/config_vectors.json` pins the verdicts both validators must share.
 * @param {unknown} obj
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateConfig(obj) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(obj)) return {ok: false, errors: ["config must be a JSON object"], warnings};
  checkObject(obj, CONFIG_SCHEMA, "", errors, warnings);
  const exclude = Array.isArray(obj.title_exclude) ? obj.title_exclude : DEFAULT_CONFIG.title_exclude;
  const seniority = Array.isArray(obj.title_seniority) ? obj.title_seniority : DEFAULT_CONFIG.title_seniority;
  for (const frag of seniority) {
    if (typeof frag === "string" && !exclude.includes(frag)) errors.push(`title_seniority: ${JSON.stringify(frag)} is not in title_exclude`);
  }
  return {ok: errors.length === 0, errors, warnings};
}

function checkObject(value, schema, path, errors, warnings) {
  for (const [key, val] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    const rule = schema[key];
    if (rule === undefined) {
      warnings.push(`${here}: unknown key (ignored by the bot)`);
    } else if (typeof rule === "object") {
      if (!isPlainObject(val)) errors.push(`${here}: must be an object`);
      else checkObject(val, rule, here, errors, warnings);
    } else {
      const problem = checkValue(val, rule, here);
      if (problem) errors.push(problem);
    }
  }
  if (!path) return;                                   // absent top-level keys just take the default, silently, as in merge_config
  const missing = Object.keys(schema).filter((key) => !(key in value));
  if (missing.length) warnings.push(`${path} is missing ${missing.join(", ")} — the bot fills them from the defaults`);
}

function checkValue(v, rule, path) {
  const isInt = Number.isInteger(v);
  switch (rule) {
    case "bool": return typeof v === "boolean" ? null : `${path}: must be true or false`;
    case "int": return isInt ? null : `${path}: must be an integer`;
    case "posint": return isInt && v > 0 ? null : `${path}: must be an integer > 0`;
    case "nonneg_int": return isInt && v >= 0 ? null : `${path}: must be an integer ≥ 0`;
    case "nonneg_num": return typeof v === "number" && Number.isFinite(v) && v >= 0 ? null : `${path}: must be a number ≥ 0`;
    case "posnum": return typeof v === "number" && Number.isFinite(v) && v > 0 ? null : `${path}: must be a number > 0`;
    case "unit": return typeof v === "number" && v >= 0 && v <= 1 ? null : `${path}: must be a number between 0 and 1`;
    case "fraction": return typeof v === "number" && v > 0 && v <= 1 ? null : `${path}: must be a number in (0, 1]`;
    case "str_or_null": return v === null || typeof v === "string" ? null : `${path}: must be a string or null`;
    case "https_url": return typeof v === "string" && v.startsWith("https://") ? null : `${path}: must start with https://`;
    case "strlist": return isStringList(v) ? null : `${path}: must be a list of strings`;
    case "regions":
      if (!isStringList(v)) return `${path}: must be a list of strings`;
      return v.every((r) => r === "US" || r === "TW") ? null : `${path}: only "US" and "TW" are known`;
    case "fraglist": return isStringList(v) ? badFragment(v, path) : `${path}: must be a list of strings`;
    case "quiet_hours": return checkQuietHours(v, path);
    default: return `${path}: unknown rule ${rule}`;
  }
}

function badFragment(list, path) {
  for (let i = 0; i < list.length; i++) {
    const frag = list[i];
    if (!frag.trim()) return `${path}[${i}]: empty fragment would match every title`;
    try {
      boundedFragmentRe(frag);
    } catch (e) {
      return `${path}[${i}]: ${JSON.stringify(frag)} does not compile (${e.message})`;
    }
  }
  return null;
}

function checkQuietHours(v, path) {
  if (v === null) return null;
  if (!isPlainObject(v)) return `${path}: must be null or {start, end, tz}`;
  for (const k of ["start", "end"]) {
    if (!Number.isInteger(v[k]) || v[k] < 0 || v[k] > 23) return `${path}.${k}: must be an integer hour 0–23`;
  }
  if (typeof v.tz !== "string" || !v.tz) return `${path}.tz: must be an IANA time zone name`;
  try {
    new Intl.DateTimeFormat("en-US", {timeZone: v.tz});
  } catch {
    return `${path}.tz: unknown time zone ${JSON.stringify(v.tz)}`;
  }
  return null;
}

function isStringList(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Same wrapper as the Python loader: `(?<![a-z0-9])(?:FRAG)(?![a-z0-9])`, case-insensitive. */
function boundedFragmentRe(frag) {
  return new RegExp(`(?<![a-z0-9])(?:${frag})(?![a-z0-9])`, "i");
}

/** Word-bounded literal phrase on an already-normalised string (Python `bounded()` in §6.2). */
function boundedRe(phrase) {
  return new RegExp(`(?<![a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`);
}

/* ------------------------------------------------------------------ error copy (§10.4.7) */

/**
 * One sentence a person can act on, from a GitHub client error (`{status, kind, headers, file}`) or a fetch
 * failure. PAT paths only carry the token/permission hints; same-origin reads (`pat:false`) just name the file.
 * @param {any} e
 * @param {{pat?: boolean, repo?: string}} [opts]
 * @returns {string}
 */
export function humanizeError(e, {pat = true, repo = ""} = {}) {
  const status = Number(e?.status) || 0;
  const file = e?.file || "status.json";
  if (e?.kind === "parse" || e instanceof SyntaxError) {
    return `${file} in the repo is not valid JSON — fix it on GitHub; nothing was pushed`;
  }
  if (e?.kind === "network" || (!status && e instanceof TypeError)) {
    return pat ? "Can't reach GitHub — check your connection" : "Network error — check your connection";
  }
  if (!pat) return `Couldn't load ${file} (HTTP ${status || "?"})`;
  if (status === 401) return "Token invalid or expired — create a new fine-grained token";
  if (status === 429 || (status === 403 && header(e, "x-ratelimit-remaining") === "0")) {
    const reset = Number(header(e, "x-ratelimit-reset"));
    return reset ? `GitHub API limit reached — retry after ${hhmm(reset)}` : "GitHub API limit reached — retry in an hour";
  }
  if (status === 403) return `Token can't write to ${repo || "the repo"}: give it Contents: Read and write`;
  if (status === 404) return "Repo or file not found — check owner/repo and the default branch";
  if (status === 409) return "Another device saved at the same time — retrying";
  if (status === 422) return "GitHub rejected the write (HTTP 422) — retrying with a fresh copy";
  if (status >= 500) return `GitHub is having trouble (HTTP ${status}) — retrying`;
  return e?.message || (status ? `HTTP ${status}` : "Unknown error");
}

function header(e, name) {
  const h = e?.headers;
  if (!h) return null;
  if (typeof h.get === "function") return h.get(name);
  return h[name] ?? h[name.toLowerCase()] ?? null;
}

function hhmm(epochS) {
  const d = new Date(epochS * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ tiny utilities */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
}
