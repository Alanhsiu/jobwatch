// node --test 'tests/js/*.test.mjs' — pure helpers in assets/lib.js (§12.2 lib.test.mjs).
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  APP_VERSION, STAGES, STAGE_RANK, CAT_ORDER, DEFAULT_CONFIG,
  norm, groupKey, parseMarks, serializeMarks, entryTime, isMark, isTomb, valueOf,
  buildView, isNew, hashToView, viewToHash, rel, isoDate, locationsOf, degreeTag, toCSV, validateConfig, humanizeError,
} from "../../assets/lib.js";

const vectors = JSON.parse(readFileSync(new URL("../fixtures/vectors.json", import.meta.url), "utf8"));
const configVectors = JSON.parse(readFileSync(new URL("../fixtures/config_vectors.json", import.meta.url), "utf8")).cases;

/** Shared tables may be `[{in, out}]` (B1 provisional / make_vectors.py) or a plain `{in: out}` map. */
function pairs(section) {
  assert.ok(section, "vector section missing");
  return Array.isArray(section) ? section.map((v) => [v.in, v.out]) : Object.entries(section);
}

const NOW = 1_788_500_000;                       // 2026-09-04T13:33:20Z
const DAY = 86400;

function role(id, extra = {}) {
  return {id, company: "TikTok", title: "Machine Learning Engineer Graduate", location: "San Jose, CA", url: "https://x.test/" + id,
    category: "ML", posted: "2026-09-01", date_posted: NOW - 3 * DAY, active: true, first_seen: NOW - 2 * DAY, ...extra};
}

/* ------------------------------------------------------------------ shared vectors */

test("norm_vectors", () => {
  const table = pairs(vectors.norm);
  assert.ok(table.length >= 20);
  for (const [input, expected] of table) assert.equal(norm(input), expected, `norm(${JSON.stringify(input)})`);
  assert.equal(norm("d-Matrix"), "d matrix");
  assert.equal(norm("Susquehanna International Group (SIG)"), "susquehanna international group sig");
  assert.equal(norm("D. E. Shaw & Co"), "d e shaw co");
  assert.equal(norm(null), "");
});

test("groupKey_vectors", () => {
  const table = vectors.group_key;
  assert.ok(Array.isArray(table) && table.length >= 10);
  for (const v of table) {
    const [company, title] = Array.isArray(v.in) ? v.in : [v.company, v.title];
    assert.equal(groupKey(company, title), v.out, `groupKey(${company}, ${title})`);
  }
  assert.equal(groupKey("Cerebras", "Software Engineer New Grad (2026)"), groupKey("Cerebras", "Software Engineer New Grad"));
});

test("isoDate", () => {
  for (const [ts, expected] of pairs(vectors.iso_date)) assert.equal(isoDate(Number(ts)), expected);
  assert.equal(isoDate(1783549489), "2026-07-08");
  assert.equal(isoDate(0), "", "a zero timestamp is 'no date', as in Python");
  assert.equal(isoDate(NaN), "");
  assert.equal(isoDate(1e20), "");
});

test("parseMarks_vectors_shared", () => {
  const table = vectors.parse_marks;
  const input = {};
  const expected = {};
  for (const v of table) {
    const id = v.id ?? `id-${Object.keys(input).length}`;
    input[id] = v.in;
    if (v.out !== null && v.out !== undefined) expected[id] = v.out;
  }
  assert.deepEqual(parseMarks(input), expected);
});

/* ------------------------------------------------------------------ marks */

test("parseMarks_legacy_string", () => {
  assert.deepEqual(parseMarks({a: "applied", b: "", c: 42, d: null}), {a: {s: "applied"}});
});

test("parseMarks_drops_unknown_stage", () => {
  assert.deepEqual(parseMarks({a: {s: "hired"}, b: "hired", c: {s: "hired", star: true}, d: {s: "<script>"}}), {c: {star: true}});
});

test("parseMarks_tombstone", () => {
  assert.deepEqual(parseMarks({a: {d: 1788600000}, b: {d: 1788600000.7}, c: {d: 0}, d: {d: "x"}}), {a: {d: 1788600000}, b: {d: 1788600000}});
  assert.deepEqual(parseMarks({a: {s: "applied", d: 5}}), {a: {s: "applied"}}, "a live mark is never also a tombstone");
});

test("parseMarks_h_items_with_null_t", () => {
  const h = [{s: "applied", t: null}, {s: "oa", t: 1789000000}, {s: "bogus", t: 1}, {t: 3}, "x"];
  const out = parseMarks({a: {s: "oa", t: 1789000000, h}});
  assert.deepEqual(out.a.h, [{s: "applied", t: null}, {s: "oa", t: 1789000000}]);
  const long = Array.from({length: 15}, (_, i) => ({s: "seen", t: i + 1}));
  assert.equal(parseMarks({a: {s: "seen", h: long}}).a.h.length, 12);
  assert.equal(parseMarks({a: {s: "seen", h: long}}).a.h[0].t, 4, "keeps the newest 12");
});

test("parseMarks_ignores_unknown_keys_and_note_trim", () => {
  assert.deepEqual(parseMarks({a: {s: "seen", note: "  hi  ", color: "red", t: 12.9}}), {a: {s: "seen", note: "hi", t: 12}});
  assert.deepEqual(parseMarks({a: {note: "   "}, b: {t: 5}, c: {}}), {});
  assert.deepEqual(parseMarks([1, 2]), {});
  assert.deepEqual(parseMarks(null), {});
});

test("serialize_prunes_old_tombstones", () => {
  const marks = {fresh: {d: NOW - 59 * DAY}, stale: {d: NOW - 61 * DAY}, live: {s: "applied", t: NOW - 400 * DAY}};
  assert.deepEqual(serializeMarks(marks, NOW), {fresh: {d: NOW - 59 * DAY}, live: {s: "applied", t: NOW - 400 * DAY}});
});

test("serialize_sorted_keys", () => {
  const out = serializeMarks({b: {t: 5, s: "seen", star: true, note: "n", h: [{t: 5, s: "seen"}]}, a: {s: "applied"}, "0": {d: NOW}}, NOW);
  assert.deepEqual(Object.keys(out), ["0", "a", "b"]);
  assert.deepEqual(Object.keys(out.b), ["h", "note", "s", "star", "t"]);
  assert.deepEqual(Object.keys(out.b.h[0]), ["s", "t"]);
  assert.equal(JSON.stringify(out), JSON.stringify(serializeMarks(out, NOW)), "canonical form is a fixed point");
});

test("serialize_whitelist", () => {
  const out = serializeMarks({a: {s: "oa", junk: 1, _v: 2, t: 7, h: [{s: "seen", t: 1, extra: true}]}, b: {d: NOW, junk: 1}}, NOW);
  assert.deepEqual(out, {a: {h: [{s: "seen", t: 1}], s: "oa", t: 7}, b: {d: NOW}});
  assert.deepEqual(serializeMarks({a: {t: 7}}, NOW), {}, "an entry with no user state is not written");
});

test("entryTime_isMark_isTomb_valueOf", () => {
  assert.equal(entryTime({s: "seen", t: 5}), 5);
  assert.equal(entryTime({d: 9}), 9);
  assert.equal(entryTime({s: "seen"}), 0);
  assert.equal(entryTime(null), 0);
  assert.ok(isMark({star: true}) && isMark({note: "x"}) && isMark({s: "seen"}));
  assert.ok(!isMark({d: 1}) && !isMark({t: 3}) && !isMark(null));
  assert.ok(isTomb({d: 1}) && !isTomb({s: "seen", d: 1}) && !isTomb({}));
  assert.equal(valueOf({s: "applied", t: 1, h: []}), '{"s":"applied"}');
  assert.equal(valueOf({s: "applied", star: 1, note: "n"}), '{"s":"applied","star":true,"note":"n"}');
  assert.equal(valueOf({d: 5}), "{}");
  assert.equal(valueOf(undefined), "");
});

/* ------------------------------------------------------------------ dates */

test("rel_today_days_weeks", () => {
  assert.equal(rel(NOW - 3600, NOW), "today");
  assert.equal(rel(NOW + 3600, NOW), "today");
  assert.equal(rel(NOW - DAY, NOW), "1d ago");
  assert.equal(rel(NOW - 13 * DAY, NOW), "13d ago");
  assert.equal(rel(NOW - 14 * DAY, NOW), "2w ago");
  assert.equal(rel(NOW - 20 * DAY, NOW), "2w ago");
  assert.equal(rel(NOW - 21 * DAY, NOW), "3w ago");
  assert.equal(rel(undefined, NOW), "");
});

test("isNew_hybrid_rule", () => {
  const r = role("a", {first_seen: NOW - 10 * DAY});
  assert.equal(isNew(r, (NOW - 11 * DAY) * 1000, null), true, "lastVisit only");
  assert.equal(isNew(r, (NOW - 9 * DAY) * 1000, null), false, "lastVisit only, visited since");
  assert.equal(isNew(r, null, NOW - 10 * DAY + 3600), true, "floor only: within 36 h of the reference");
  assert.equal(isNew(r, null, NOW), false, "floor only: too old");
  assert.equal(isNew(r, (NOW - 9 * DAY) * 1000, NOW - 10 * DAY), true, "both: floor rescues a glance-and-close");
  assert.equal(isNew(r, null, null), false, "none");
  assert.equal(isNew({id: "m", manual: true, added: NOW - 3600, date_posted: NOW - 90 * DAY}, null, NOW), true, "manual roles use `added`");
  assert.equal(isNew({id: "x"}, 0, NOW), false, "no timestamp at all");
});

/* ------------------------------------------------------------------ views */

const ROLES = [
  role("t1", {group: "tiktok|mle graduate", first_seen: NOW - 3600}),
  role("t2", {group: "tiktok|mle graduate", location: "Seattle, WA", locations: ["Seattle, WA"], first_seen: NOW - 10 * DAY, date_posted: NOW - 4 * DAY}),
  role("t3", {group: "tiktok|mle graduate", first_seen: NOW - 10 * DAY, date_posted: NOW - 5 * DAY}),
  role("c1", {company: "Cerebras", title: "Software Engineer New Grad", category: "HW", first_seen: NOW - 10 * DAY}),
  role("x1", {company: "xAI", title: "Member of Technical Staff", category: "SWE", active: false, in_feed: false, closed_at: NOW - 2 * DAY, first_seen: NOW - 30 * DAY}),
  role("z1", {company: "Zoox", title: "Data Analyst", category: "SWE", active: false, in_feed: true, reason: "untracked", why: "title", first_seen: NOW - 30 * DAY}),
  role("b1", {company: "Bridgewater", title: "Trading Associate", category: "Quant", active: false, first_seen: NOW - 30 * DAY}),
];
const MARKS = {
  t2: {s: "applied", t: NOW - DAY},
  x1: {s: "applied", t: NOW - 20 * DAY},
  c1: {star: true, t: NOW - 3 * DAY},
  b1: {s: "interview"},
  z1: {d: NOW - DAY},
};
const opts = {lastVisitMs: (NOW - 2 * DAY) * 1000, metaLastRunS: NOW - 3600};

test("buildView_inbox_excludes_inactive", () => {
  const v = buildView(ROLES, MARKS, {f: "inbox"}, NOW, opts);
  const ids = v.rows.flatMap((r) => r.ids).sort();
  assert.deepEqual(ids, ["c1", "t1", "t3"], "active todo only: t2 applied, x1/z1/b1 inactive");
  assert.equal(v.counts.inbox, 3);
  assert.equal(v.counts.untracked, 1);
  assert.equal(v.counts.closed, 2, "x1 (in_feed:false) and legacy b1 (no in_feed ⇒ treated as closed), both marked");
  assert.equal(v.counts.pipeline, 3, "t2 applied, x1 applied (closed rows count), b1 interview");
  assert.equal(v.sections[0].name, "Cerebras", "company sections sorted by name");
  assert.equal(v.total, 3);
});

test("buildView_new_subset_of_inbox", () => {
  const inbox = new Set(buildView(ROLES, MARKS, {f: "inbox"}, NOW, opts).rows.flatMap((r) => r.ids));
  const fresh = buildView(ROLES, MARKS, {f: "new"}, NOW, opts);
  const ids = fresh.rows.flatMap((r) => r.ids);
  assert.deepEqual(ids, ["t1"]);
  for (const id of ids) assert.ok(inbox.has(id));
  assert.equal(fresh.view.s, "added", "New defaults to the recently-added sort");
  assert.equal(fresh.counts.new, 1);
  const noMeta = buildView(ROLES, MARKS, {f: "new"}, NOW, {lastVisitMs: null, metaLastRunS: null});
  assert.deepEqual(noMeta.rows.flatMap((r) => r.ids), ["t1"], "without meta.json the newest first_seen is the reference");
});

test("buildView_pipeline_order_null_t_last", () => {
  const v = buildView(ROLES, MARKS, {f: "pipeline"}, NOW, opts);
  assert.equal(v.view.s, "updated");
  assert.deepEqual(v.rows.map((r) => r.id), ["t2", "x1", "b1"], "t desc, legacy null t last");
  assert.deepEqual(v.sections.map((s) => s.key), ["interview", "applied"], "stage sections most advanced first");
  assert.deepEqual(v.sections[1].rows.map((r) => r.id), ["t2", "x1"]);
});

test("buildView_groups_within_view_only", () => {
  const inbox = buildView(ROLES, MARKS, {f: "inbox"}, NOW, opts);
  const tiktok = inbox.rows.find((r) => r.key === "tiktok|mle graduate");
  assert.deepEqual(tiktok.ids, ["t1", "t3"], "the applied sibling t2 is not in the Inbox group");
  assert.equal(tiktok.id, "t1", "primary = newest posting");
  assert.equal(tiktok.isNew, true, "NEW if any member is new");
  const applied = buildView(ROLES, MARKS, {f: "applied"}, NOW, opts);
  assert.deepEqual(applied.rows.map((r) => r.ids), [["t2"], ["x1"]]);
  const all = buildView(ROLES, MARKS, {f: "all", s: "newest"}, NOW, opts);
  assert.deepEqual(all.rows.find((r) => r.key === "tiktok|mle graduate").ids, ["t1", "t2", "t3"], "all three fold in All");
  assert.equal(all.sections.length, 1, "flat sorts have one anonymous section");
  const computed = buildView([role("p", {group: undefined}), role("q", {group: undefined, title: "Machine Learning Engineer Graduate (2026)"})], {}, {f: "inbox"}, NOW, opts);
  assert.equal(computed.rows.length, 1, "group key computed client-side when the bot field is absent");
});

test("buildView_all_hide_closed", () => {
  const hidden = buildView(ROLES, MARKS, {f: "all"}, NOW, opts).rows.flatMap((r) => r.ids).sort();
  assert.deepEqual(hidden, ["b1", "c1", "t1", "t2", "t3", "x1"], "hide-closed on: inactive rows without a mark (z1, tombstoned) are hidden");
  const shown = buildView(ROLES, MARKS, {f: "all", hc: false}, NOW, opts).rows.flatMap((r) => r.ids).sort();
  assert.deepEqual(shown, ["b1", "c1", "t1", "t2", "t3", "x1", "z1"]);
  const fromHash = buildView(ROLES, MARKS, hashToView("#f=all&hc=0"), NOW, opts);
  assert.equal(fromHash.total, 7);
});

test("buildView_filters_cat_co_q", () => {
  assert.deepEqual(buildView(ROLES, MARKS, {f: "inbox", cat: ["HW"]}, NOW, opts).rows.map((r) => r.id), ["c1"]);
  const co = buildView(ROLES, MARKS, {f: "all", co: "tiktok"}, NOW, opts);
  assert.deepEqual(co.rows.flatMap((r) => r.ids).sort(), ["t1", "t2", "t3"]);
  assert.equal(co.counts.inbox, 2, "counts follow cat/co filters");
  assert.deepEqual(buildView(ROLES, MARKS, {f: "all", co: "tik"}, NOW, opts).rows, [], "co is word-bounded like the bot");
  const q = buildView(ROLES, MARKS, {f: "inbox", q: "SEATTLE"}, NOW, opts);
  assert.deepEqual(q.rows, [], "t2 is Seattle but not in Inbox");
  assert.deepEqual(buildView(ROLES, MARKS, {f: "all", q: "seattle"}, NOW, opts).rows.flatMap((r) => r.ids), ["t2"]);
  assert.equal(buildView(ROLES, MARKS, {f: "all", q: "seattle"}, NOW, opts).counts.all, 6, "search does not change tab counts");
  const withNote = buildView(ROLES, {...MARKS, c1: {star: true, note: "recruiter Sam"}}, {f: "all", q: "sam"}, NOW, opts);
  assert.deepEqual(withNote.rows.map((r) => r.id), ["c1"], "notes are searched");
});

test("mostAdvancedStage", () => {
  const marks = {t1: {s: "seen"}, t2: {s: "oa"}, t3: {s: "dropped"}};
  const v = buildView(ROLES.slice(0, 3), marks, {f: "all"}, NOW, opts);
  assert.equal(v.rows[0].stage, "oa");
  assert.deepEqual(v.rows[0].members.map((m) => m.stage), ["seen", "oa", "dropped"]);
  assert.equal(buildView(ROLES.slice(0, 3), {t1: {s: "rejected"}, t2: {s: "applied"}}, {f: "all"}, NOW, opts).rows[0].stage, "applied");
  assert.equal(buildView(ROLES.slice(0, 3), {}, {f: "all"}, NOW, opts).rows[0].stage, "todo");
  assert.ok(STAGE_RANK.offer > STAGE_RANK.interview && STAGE_RANK.interview > STAGE_RANK.oa && STAGE_RANK.oa > STAGE_RANK.applied
    && STAGE_RANK.applied > STAGE_RANK.rejected && STAGE_RANK.rejected > STAGE_RANK.seen && STAGE_RANK.seen > STAGE_RANK.dropped && STAGE_RANK.dropped > STAGE_RANK.todo);
});

test("buildView_sorts", () => {
  const closed = buildView(ROLES, MARKS, {f: "closed"}, NOW, opts);
  assert.equal(closed.view.s, "closed");
  assert.deepEqual(closed.rows.map((r) => r.id), ["x1", "b1"], "closed_at desc; a legacy row without closed_at sorts last");
  const oldest = buildView(ROLES, MARKS, {f: "inbox", s: "oldest"}, NOW, opts).rows.map((r) => r.newest);
  assert.deepEqual(oldest, [...oldest].sort((a, b) => a - b));
  const company = buildView(ROLES, MARKS, {f: "all", hc: false}, NOW, opts);
  assert.deepEqual(company.sections.map((s) => s.name), ["Bridgewater", "Cerebras", "TikTok", "xAI", "Zoox"]);
  const cats = buildView([role("q", {category: "Quant", title: "Quant Dev"}), role("s", {category: "SWE", title: "SWE"}),
    role("h", {category: "HW", title: "Firmware"}), role("m", {category: "ML", title: "MLE"})], {}, {f: "inbox"}, NOW, opts);
  assert.deepEqual(cats.rows.map((r) => r.category), ["Quant", "ML", "SWE", "HW"], "within a company: CAT_ORDER");
});

/* ------------------------------------------------------------------ hash */

test("hash_roundtrip_and_new_alias", () => {
  assert.deepEqual(hashToView("#new"), {f: "new", s: "added", cat: [], co: "", hc: true, q: ""});
  assert.deepEqual(hashToView(""), {f: "inbox", s: "company", cat: [], co: "", hc: true, q: ""});
  const v = hashToView("#f=inbox&s=newest&cat=ML,SWE&co=tiktok&hc=0&q=infra%20eng");
  assert.deepEqual(v, {f: "inbox", s: "newest", cat: ["ML", "SWE"], co: "tiktok", hc: false, q: "infra eng"});
  assert.deepEqual(hashToView(viewToHash(v)), v);
  assert.equal(viewToHash({f: "inbox"}), "#f=inbox", "defaults omitted");
  assert.equal(viewToHash({f: "all", cat: ["SWE", "ML"], q: "a&b"}), "#f=all&cat=ML,SWE&q=a%26b");
  assert.deepEqual(hashToView("#f=bogus&s=bogus&cat=XX,HW").f, "inbox");
  assert.deepEqual(hashToView("#f=pipeline&cat=XX,HW"), {f: "pipeline", s: "updated", cat: ["HW"], co: "", hc: true, q: ""});
  assert.equal(hashToView("#f=new&co=TikTok!").co, "tiktok", "co is normalised");
});

/* ------------------------------------------------------------------ formatters */

test("toCSV_escapes", () => {
  const csv = toCSV([{company: "D. E. Shaw & Co", note: 'say "hi", then\nleave', n: 3, x: null}]);
  assert.equal(csv, 'company,note,n,x\r\nD. E. Shaw & Co,"say ""hi"", then\nleave",3,\r\n');
  assert.equal(toCSV([{a: 1, b: 2}], ["b"]), "b\r\n2\r\n");
  assert.equal(toCSV([]), "\r\n");
});

test("toCSV_neutralises_formulas", () => {
  const csv = toCSV([{a: '=HYPERLINK("x","y")', b: "+cmd|' /C calc'!A0", c: "-1+1", d: "@SUM(A1)", n: -3}]);
  assert.equal(csv, 'a,b,c,d,n\r\n"\'=HYPERLINK(""x"",""y"")",\'+cmd|\' /C calc\'!A0,\'-1+1,\'@SUM(A1),-3\r\n');
  assert.equal(toCSV([{t: "\tx", r: "\ry"}]), "t,r\r\n'\tx,\"'\ry\"\r\n", "tab and CR triggers are prefixed too (CR still quoted)");
  assert.equal(toCSV([{s: "x-y", u: "a=b", z: 0}]), "s,u,z\r\nx-y,a=b,0\r\n", "only a leading trigger counts; numbers untouched");
});

test("degreeTag", () => {
  assert.equal(degreeTag(["Bachelor's", "Master's"]), "BS/MS");
  assert.equal(degreeTag(["PhD", "Master's"]), "MS/PhD");
  assert.equal(degreeTag(["PhD"]), "PhD");
  assert.equal(degreeTag([]), "");
  assert.equal(degreeTag(["JD"]), "");
  assert.equal(degreeTag(undefined), "");
});

test("locationsOf", () => {
  assert.deepEqual(locationsOf({locations: ["San Jose, CA", "Seattle, WA"], location: "x"}), ["San Jose, CA", "Seattle, WA"]);
  assert.deepEqual(locationsOf({locations: [], location: "San Jose, CA, Seattle, WA"}), ["San Jose, CA, Seattle, WA"]);
  assert.deepEqual(locationsOf({}), []);
});

/* ------------------------------------------------------------------ config */

test("validateConfig_type_table_and_regex", () => {
  assert.deepEqual(validateConfig({}), {ok: true, errors: [], warnings: []});
  assert.deepEqual(validateConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG))), {ok: true, errors: [], warnings: []},
    "defaults validate: every DEFAULT_CONFIG key is in the schema and every schema key has a default");
  const bad = validateConfig({
    max_age_days: 0, regions: ["EU"], feed_url: "http://x", title_exclude: ["senior", "("], hardware_rescue: {enabled: "yes"},
    feed: {min_active_ratio: 2}, telegram: {quiet_hours: {start: 25, end: 8, tz: "Mars/Olympus"}}, bogus: 1, pages_url: 5,
  });
  assert.equal(bad.ok, false);
  const text = bad.errors.join("\n");
  for (const needle of ["max_age_days", "regions", "feed_url", "title_exclude[1]", "hardware_rescue.enabled", "feed.min_active_ratio",
    "telegram.quiet_hours.start", "title_seniority", "pages_url"]) {
    assert.match(text, new RegExp(needle.replace(/[.[\]]/g, "\\$&")), `error names ${needle}`);
  }
  assert.deepEqual(bad.warnings, [
    "hardware_rescue is missing include, exclude — the bot fills them from the defaults",
    "feed is missing min_records, min_active, required_keys — the bot fills them from the defaults",
    "telegram is missing html, max_lines_per_company, max_messages_per_run, pace_seconds, chunk_chars, deep_link, deadline_seconds — the bot fills them from the defaults",
    "bogus: unknown key (ignored by the bot)",
  ], "partial objects warn (the bot fills them); only the unknown key is otherwise noted");
  assert.equal(validateConfig({title_exclude: ["senior"]}).errors.length > 0, true, "default title_seniority must stay a subset");
  assert.equal(validateConfig({title_exclude: ["senior"], title_seniority: ["senior"]}).ok, true);
  const telegram = (patch) => ({telegram: {...DEFAULT_CONFIG.telegram, ...patch}});
  assert.equal(validateConfig(telegram({quiet_hours: null})).ok, true);
  assert.equal(validateConfig(telegram({quiet_hours: {start: 23, end: 8, tz: "America/Los_Angeles"}})).ok, true);
  assert.equal(validateConfig(telegram({quiet_hours: {start: 23, end: 8, tz: "Mars/Olympus"}})).ok, false);
  assert.equal(validateConfig(telegram({deadline_seconds: 1.5})).ok, true, "a number > 0, as in jobwatch.py");
  assert.match(validateConfig(telegram({deadline_seconds: 0})).errors[0], /telegram\.deadline_seconds: must be a number > 0/);
  assert.equal(validateConfig({title_keep: ["new grad", ""]}).ok, false, "empty fragment refused");
  assert.equal(validateConfig({phd_title: ["ph\\.?\\s?d"], regions: []}).ok, true, "[] regions = no filter");
  assert.equal(validateConfig([]).ok, false);
});

test("validateConfig_partial_nested_object_fills_from_defaults_with_warning", () => {
  const fill = (key, subs) => `${key} is missing ${subs} — the bot fills them from the defaults`;
  const partial = validateConfig({feed: {min_records: 500}});
  assert.equal(partial.ok, true, "merge_config fills the missing sub-keys, so the page must not refuse what the bot runs on");
  assert.deepEqual(partial.errors, []);
  assert.deepEqual(partial.warnings, [fill("feed", "min_active, min_active_ratio, required_keys")]);
  assert.deepEqual(validateConfig({feed: {...DEFAULT_CONFIG.feed, min_records: 500}}).warnings, [], "a complete object warns about nothing");
  assert.deepEqual(validateConfig({max_age_days: 30}).warnings, [], "absent top-level keys take the default silently");
  assert.deepEqual(validateConfig({hardware_rescue: {enabled: false}}).warnings, [fill("hardware_rescue", "include, exclude")]);
  assert.deepEqual(validateConfig({readme: {}}).warnings, [fill("readme", "collapse_over")]);
  const lone = validateConfig({telegram: {quiet_hours: null}});
  assert.equal(lone.ok, true, "a lone quiet_hours is what Settings writes when config.json had no telegram object");
  assert.deepEqual(lone.warnings, [fill("telegram", "html, max_lines_per_company, max_messages_per_run, pace_seconds, chunk_chars, deep_link, deadline_seconds")]);
  const mixed = validateConfig({feed: {min_records: -1}});
  assert.equal(mixed.ok, false, "a wrong type inside a partial object is still an error");
  assert.match(mixed.errors[0], /^feed\.min_records: /);
  assert.deepEqual(mixed.warnings, [fill("feed", "min_active, min_active_ratio, required_keys")]);
});

test("validateConfig_shared_vectors", () => {
  assert.ok(configVectors.length >= 20);
  const fillNote = / — the bot fills them from the defaults$/;
  for (const c of configVectors) {
    const check = validateConfig(c.in);
    assert.equal(check.ok, c.ok, `${c.label}: ${JSON.stringify(check.errors)}`);
    if (!c.ok) {
      assert.ok(check.errors.some((e) => e.startsWith(c.error_key)), `${c.label}: an error must name ${c.error_key}: ${JSON.stringify(check.errors)}`);
      continue;
    }
    const fills = Object.entries(c.filled ?? {}).map(([key, subs]) => `${key} is missing ${subs.join(", ")} — the bot fills them from the defaults`);
    assert.deepEqual(check.warnings.filter((w) => fillNote.test(w)), fills, c.label);
    for (const key of c.unknown ?? []) assert.ok(check.warnings.includes(`${key}: unknown key (ignored by the bot)`), `${c.label}: warns about ${key}`);
    assert.equal(check.warnings.length, fills.length + (c.unknown ?? []).length, `${c.label}: no other warnings`);
  }
});

test("humanizeError_table", () => {
  const e = (status, extra = {}) => ({status, kind: "http", headers: {}, ...extra});
  assert.match(humanizeError(e(401)), /Token invalid or expired/);
  assert.match(humanizeError(e(403), {repo: "o/r"}), /can't write to o\/r/);
  assert.match(humanizeError(e(403, {headers: {"x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW)}})), /API limit reached — retry after \d\d:\d\d/);
  assert.match(humanizeError(e(404)), /Repo or file not found/);
  assert.match(humanizeError(e(409)), /Another device saved/);
  assert.match(humanizeError(e(502)), /HTTP 502/);
  assert.match(humanizeError({status: 200, kind: "parse", file: "status.json"}), /status.json in the repo is not valid JSON/);
  assert.match(humanizeError(new SyntaxError("x")), /not valid JSON/);
  assert.match(humanizeError({kind: "network"}), /Can't reach GitHub/);
  assert.match(humanizeError(new TypeError("fetch failed")), /Can't reach GitHub/);
  assert.equal(humanizeError(e(404, {file: "roles.json"}), {pat: false}), "Couldn't load roles.json (HTTP 404)");
});

test("constants", () => {
  assert.equal(typeof APP_VERSION, "number");
  assert.ok(Number.isInteger(APP_VERSION) && APP_VERSION >= 2);
  assert.deepEqual([...STAGES], ["todo", "seen", "applied", "oa", "interview", "offer", "rejected", "dropped"]);
  assert.deepEqual(CAT_ORDER, {Quant: 0, ML: 1, SWE: 2, HW: 3});
  assert.throws(() => { DEFAULT_CONFIG.deny.push("x"); }, "DEFAULT_CONFIG is frozen");
  assert.deepEqual(DEFAULT_CONFIG.regions, ["US", "TW"]);
  assert.equal(DEFAULT_CONFIG.telegram.quiet_hours, null);
  assert.ok(DEFAULT_CONFIG.title_exclude.includes("intern") && DEFAULT_CONFIG.title_exclude.includes("internship"));
});
