// node --test 'tests/js/*.test.mjs' — the sync engine (assets/sync.js) against fake fetch / storage / clock / online.
// Every §12.2 sync.test.mjs name exists below; the fakes are local to this file so the suite has no helper module.
import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createSync} from "../../assets/sync.js";

const T0 = 1_788_500_000_000;                    // 2026-09-04T13:33:20Z in ms
const T0S = T0 / 1000;
const REPO = "owner/jobwatch";
const PAT = "ghp_ok";
const KEYS = ["jobwatch.marks.v3", "jobwatch.marks.v2", "jobwatch.dirty.v1", "jobwatch.migrated.v3", "jobwatch.trash.v1",
  "jobwatch.gh.repo", "jobwatch.gh.pat", "jobwatch.sync.off", "jobwatch.sync.v1"];

/* ------------------------------------------------------------------ fakes */

function makeStorage(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, String(v)); },
    del: (k) => { m.delete(k); },
    json: (k) => (m.has(k) ? JSON.parse(m.get(k)) : undefined),
    keys: () => [...m.keys()],
  };
}

/** Deterministic clock + timer queue. `advance(ms)` fires due timers in order and lets promise chains settle. */
function makeClock(start = T0) {
  let t = start;
  const timers = new Map();
  let seq = 0;
  const clock = {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, {at: t + Math.max(0, ms), fn});
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    jump(ms) { t += ms; },
    async settle() { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await clock.settle();
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next.x.at || (x.at === next.x.at && id < next.id))) next = {id, x};
        if (!next) break;
        timers.delete(next.id);
        t = Math.max(t, next.x.at);
        next.x.fn();
      }
      t = end;
      await clock.settle();
    },
  };
  return clock;
}

const blobSha = (content) => createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
const enc = (s) => Buffer.from(s, "utf8").toString("base64").replace(/(.{60})/g, "$1\n");
const dec = (b) => Buffer.from(String(b).replace(/\s+/g, ""), "base64").toString("utf8");
const asText = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 1) + "\n");

function res(status, body, headers = {}) {
  const text = body === null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status, ok: status >= 200 && status < 300,
    headers: {get: (n) => h[n.toLowerCase()] ?? null, forEach: (fn) => Object.entries(h).forEach(([k, v]) => fn(v, k))},
    async json() { return JSON.parse(text); },
    async text() { return text; },
  };
}

/** In-memory GitHub Contents/Actions API + same-origin Pages mirror, with one-shot scripted overrides. */
function makeGitHub({repo = REPO, pat = PAT, files = {}, pages = {}} = {}) {
  const store = new Map();
  const put = (path, content) => store.set(path, {content, sha: blobSha(content)});
  for (const [f, v] of Object.entries(files)) put(f, asText(v));
  const gh = {
    store, pages: {...pages}, calls: [], scripts: [], runs: [], commits: 0, dispatches: 0,
    file: (path) => (store.has(path) ? JSON.parse(store.get(path).content) : undefined),
    sha: (path) => store.get(path)?.sha,
    set: (path, v) => put(path, asText(v)),
    once: (match, respond) => gh.scripts.push({match, respond}),
    count: (pred) => gh.calls.filter(pred).length,
    async fetch(url, init = {}) {
      const req = {method: init.method || "GET", url, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null,
        path: (url.startsWith("http") ? new URL(url) : new URL(url, "http://pages.test/")).pathname};
      gh.calls.push(req);
      const i = gh.scripts.findIndex((s) => s.match(req));
      if (i >= 0) return gh.scripts.splice(i, 1)[0].respond(req);
      return gh.route(req);
    },
    route(req) {
      const {method, url, headers, body, path} = req;
      if (!url.startsWith("http")) {
        const file = path.replace(/^\//, "");
        return file in gh.pages ? res(200, gh.pages[file]) : res(404, {message: "Not Found"});
      }
      if (headers.Authorization !== `Bearer ${pat}`) return res(401, {message: "Bad credentials"});
      const base = `/repos/${repo}`;
      if (!path.startsWith(base)) return res(404, {message: "Not Found"});
      const rest = path.slice(base.length);
      if (rest === "" && method === "GET") return res(200, {default_branch: "main", permissions: {push: true}});
      if (rest.startsWith("/contents/")) {
        const file = rest.slice("/contents/".length);
        const cur = store.get(file);
        if (method === "GET") return cur ? res(200, {content: enc(cur.content), sha: cur.sha, encoding: "base64"}) : res(404, {message: "Not Found"});
        if (method === "PUT") {
          if (cur && body.sha !== cur.sha) return res(409, {message: `${file} does not match ${cur.sha}`});
          if (!cur && body.sha) return res(422, {message: `${file} does not exist`});
          put(file, dec(body.content));
          gh.commits++;
          return res(cur ? 200 : 201, {content: {sha: store.get(file).sha}, commit: {sha: "c".repeat(40)}});
        }
      }
      if (rest === "/actions/workflows/jobwatch.yml/dispatches" && method === "POST") {
        gh.dispatches++;
        return res(204, null);
      }
      if (rest.startsWith("/actions/workflows/jobwatch.yml/runs")) return res(200, {workflow_runs: gh.runs});
      return res(404, {message: "Not Found"});
    },
  };
  return gh;
}

const isPut = (file) => (r) => r.method === "PUT" && r.path.endsWith(`/contents/${file}`);
const isGet = (file) => (r) => r.method === "GET" && r.path.endsWith(`/contents/${file}`);
const isApi = (r) => r.url.startsWith("https://api.github.com/");

function boot({storage = makeStorage(), gh = makeGitHub(), clock = makeClock(), online = () => true, repo = REPO, pat = PAT, branch = null} = {}) {
  if (pat) storage.set("jobwatch.gh.pat", pat);
  else storage.del("jobwatch.gh.pat");
  if (repo) storage.set("jobwatch.gh.repo", repo);
  else storage.del("jobwatch.gh.repo");
  const events = {marks: [], banners: [], health: [], logs: []};
  const sync = createSync({
    fetch: gh.fetch, storage, now: clock.now, online, branch, timers: clock,
    onMarks: (ids) => events.marks.push([...ids]),
    onHealth: (h) => events.health.push(h.state),
    onBanner: (id, payload) => events.banners.push([id, payload]),
    onLog: (level, msg) => events.logs.push(`${level}: ${msg}`),
  });
  const banner = (id) => events.banners.filter(([i]) => i === id).map(([, p]) => p);
  return {sync, storage, gh, clock, events, banner};
}

async function step(iterator, clock, ms = 10000) {
  const p = iterator.next();
  await clock.advance(ms);
  return (await p).value;
}

const legacyMarks = (n) => Object.fromEntries(Array.from({length: n}, (_, i) => [`simplify:${i}`, {s: i % 3 ? "dropped" : "applied"}]));

/* ------------------------------------------------------------------ commit / persistence (§10.4.3) */

test("commit_stamps_t_and_h", () => {
  const {sync, clock, storage, events} = boot();
  assert.equal(sync.commit("a", {s: "applied"}), null);
  assert.deepEqual(sync.marks.a, {s: "applied", t: T0S, h: [{s: "applied", t: T0S}]});
  assert.ok(sync.dirty.has("a"));
  assert.deepEqual(events.marks, [["a"]]);
  clock.jump(5000);
  const prev = sync.commit("a", {s: "oa"});
  assert.deepEqual(prev, {s: "applied", t: T0S, h: [{s: "applied", t: T0S}]});
  assert.deepEqual(sync.marks.a.h, [{s: "applied", t: T0S}, {s: "oa", t: T0S + 5}]);
  clock.jump(1000);
  sync.commit("a", {...sync.marks.a, star: true});
  assert.equal(sync.marks.a.t, T0S + 6, "star change bumps t");
  assert.equal(sync.marks.a.h.length, 2, "h records stages only");
  for (let i = 0; i < 15; i++) {
    clock.jump(1000);
    sync.commit("a", {s: i % 2 ? "oa" : "applied"});
  }
  assert.equal(sync.marks.a.h.length, 12, "history capped at 12");
  assert.deepEqual(storage.json("jobwatch.marks.v3").a.h, sync.marks.a.h, "persisted verbatim");
  assert.deepEqual(storage.json("jobwatch.dirty.v1"), ["a"]);
  sync.commit("a", null);
  assert.deepEqual(sync.marks.a, {d: T0S + 21}, "null writes a tombstone");
  clock.jump(1000);
  assert.deepEqual(sync.commit("a", null), {d: T0S + 21}, "deleting again returns the tombstone unchanged");
  assert.equal(sync.marks.a.d, T0S + 21, "no d bump on a repeated delete");
});

test("commit_same_stage_noop", () => {
  const {sync, clock, storage, events} = boot();
  sync.commit("a", {s: "applied"});
  const persisted = storage.get("jobwatch.marks.v3");
  clock.jump(9000);
  const prev = sync.commit("a", {s: "applied"});
  assert.deepEqual(prev, sync.marks.a);
  assert.equal(sync.marks.a.t, T0S, "no t bump");
  assert.equal(storage.get("jobwatch.marks.v3"), persisted);
  assert.equal(events.marks.length, 1, "no onMarks for a no-op");
  assert.deepEqual(sync.commit("a", {s: "applied", note: ""}), sync.marks.a, "empty note is no value");
  assert.equal(sync.marks.a.t, T0S);
});

test("legacy_first_change_seeds_null_history", () => {
  const storage = makeStorage({"jobwatch.marks.v3": {a: {s: "applied"}, b: {s: "seen", h: [{s: "seen", t: 5}]}}, "jobwatch.migrated.v3": {at: 1, check: false}});
  const {sync} = boot({storage});
  sync.commit("a", {s: "oa"});
  assert.deepEqual(sync.marks.a, {s: "oa", t: T0S, h: [{s: "applied", t: null}, {s: "oa", t: T0S}]});
  sync.commit("b", {s: "applied"});
  assert.deepEqual(sync.marks.b.h, [{s: "seen", t: 5}, {s: "applied", t: T0S}], "existing h is extended, not re-seeded");
});

test("absorbDisk_takes_other_tabs_newer_edit", () => {
  const {sync, storage, events} = boot();
  sync.commit("a", {s: "applied"});
  sync.commit("b", {s: "seen"});
  storage.set("jobwatch.marks.v3", JSON.stringify({a: {s: "oa", t: T0S + 10}, b: {s: "dropped", t: T0S - 10}, c: {s: "applied", t: T0S}}));
  storage.set("jobwatch.dirty.v1", JSON.stringify(["a", "c"]));
  const changed = sync.absorbDisk();
  assert.deepEqual(changed.sort(), ["a", "c"]);
  assert.equal(sync.marks.a.s, "oa", "newer edit taken");
  assert.equal(sync.marks.b.s, "seen", "older disk copy ignored");
  assert.equal(sync.marks.c.s, "applied", "unknown id imported");
  assert.ok(sync.dirty.has("c"), "the other tab's unacknowledged edit becomes ours to push");
  assert.deepEqual(events.marks.at(-1).sort(), ["a", "c"]);
});

test("persistAll_does_not_resurrect_dropped_ids", async () => {
  const storage = makeStorage({"jobwatch.marks.v3": legacyMarks(170), "jobwatch.migrated.v3": {at: 1, check: false}});
  const gh = makeGitHub({files: {"status.json": {}}});
  const {sync, events} = boot({storage, gh});
  assert.equal(Object.keys(sync.marks).length, 170);
  await sync.pull("boot");
  assert.deepEqual(sync.marks, {});
  assert.deepEqual(storage.json("jobwatch.marks.v3"), {}, "disk holds 0 marks");
  const trash = storage.json("jobwatch.trash.v1");
  assert.equal(trash.length, 100, "every drop was stashed once; the stash keeps the newest 100 (§5.8 cap)");
  assert.equal(trash.at(-1).id, "simplify:169");
  assert.equal(events.marks.at(-1).length, 170);
  await sync.pull("again");
  sync.commit("simplify:new", {s: "seen"});
  assert.deepEqual(Object.keys(storage.json("jobwatch.marks.v3")), ["simplify:new"]);
  assert.deepEqual(storage.json("jobwatch.trash.v1"), trash, "trash filled once, not per cycle");
  assert.ok(trash.every((x) => x.why === "remote-deleted" && x.at === T0));
});

test("discard_orphans_persists", async () => {
  const storage = makeStorage({"jobwatch.marks.v2": {a: "applied", b: {s: "dropped"}, c: {s: "seen", star: true}}});
  const gh = makeGitHub({files: {"status.json": {}}});
  const {sync, banner, events} = boot({storage, gh});
  assert.deepEqual(storage.json("jobwatch.migrated.v3").check, true);
  await sync.pull();
  assert.equal(Object.keys(sync.marks).length, 3, "orphans are held, not dropped");
  const [payload] = banner("local-orphans");
  assert.equal(payload.n, 3);
  assert.deepEqual(sync.migrationCheck(), {pending: true, orphans: ["a", "b", "c"]});
  payload.discard();
  assert.deepEqual(sync.marks, {});
  assert.deepEqual(storage.json("jobwatch.marks.v3"), {});
  assert.deepEqual(storage.json("jobwatch.dirty.v1"), []);
  assert.equal(storage.json("jobwatch.migrated.v3").check, false);
  assert.deepEqual(storage.json("jobwatch.trash.v1").map((x) => x.why), ["discarded", "discarded", "discarded"]);
  assert.deepEqual(events.marks.at(-1), ["a", "b", "c"]);
  await sync.pull();
  assert.deepEqual(sync.marks, {}, "nothing comes back on the next pull");
  const again = boot({storage, gh}).sync;
  assert.deepEqual(again.marks, {}, "a reload does not re-import marks.v2");
  assert.equal(gh.commits, 0);
});

test("storage_event_stale_copy_of_removed_id_not_reimported", async () => {
  const storage = makeStorage({"jobwatch.marks.v3": {a: {s: "applied", t: T0S - 100}}, "jobwatch.migrated.v3": {at: 1, check: false}});
  const {sync} = boot({storage, gh: makeGitHub({files: {"status.json": {}}})});
  await sync.pull();
  assert.deepEqual(sync.marks, {});
  storage.set("jobwatch.marks.v3", JSON.stringify({a: {s: "applied", t: T0S - 100}}));
  assert.deepEqual(sync.absorbDisk(), []);
  assert.deepEqual(sync.marks, {});
  storage.set("jobwatch.marks.v3", JSON.stringify({a: {s: "applied"}}));
  assert.deepEqual(sync.absorbDisk(), [], "a t-less stale copy is not re-imported either");
});

test("storage_event_newer_remark_is_reimported", async () => {
  const storage = makeStorage({"jobwatch.marks.v3": {a: {s: "applied", t: T0S - 100}}, "jobwatch.migrated.v3": {at: 1, check: false}});
  const {sync, clock} = boot({storage, gh: makeGitHub({files: {"status.json": {}}})});
  await sync.pull();
  clock.jump(5000);
  storage.set("jobwatch.marks.v3", JSON.stringify({a: {s: "applied", t: T0S + 5}}));
  assert.deepEqual(sync.absorbDisk(), ["a"]);
  assert.equal(sync.marks.a.t, T0S + 5);
});

test("pull_case8_loser_is_not_resurrected_by_disk", async () => {
  const storage = makeStorage({"jobwatch.marks.v2": {x: {s: "oa"}}});                 // first boot after the upgrade: migrated, t-less, clean
  const gh = makeGitHub({files: {"status.json": {x: {s: "dropped"}}}});
  const {sync, banner} = boot({storage, gh});
  await sync.pull("boot");
  assert.deepEqual(sync.marks.x, {s: "dropped"}, "case 8: values differ, local clean ⇒ remote wins");
  assert.deepEqual(storage.json("jobwatch.marks.v3").x, {s: "dropped"}, "the verdict is persisted — this tab's own stale copy is not an edit to absorb");
  assert.deepEqual(storage.json("jobwatch.trash.v1").map((t) => [t.id, t.why, t.entry.s]), [["x", "lww-loser", "oa"]]);
  assert.deepEqual(banner("local-orphans"), [], "x exists remotely: not an orphan");
  await sync.pull("again");
  assert.deepEqual(sync.marks.x, {s: "dropped"});
  assert.equal(storage.json("jobwatch.trash.v1").length, 1, "no churn on later pulls");
  sync.commit("y", {s: "seen"});
  await sync.flushNow();
  assert.deepEqual(gh.file("status.json").x, {s: "dropped"}, "the next push writes the verdict, not the loser");
});

test("pull_adopts_tless_remote_change_and_next_push_keeps_it", async () => {
  const h = [{s: "applied", t: T0S - 1000}];
  const storage = makeStorage({
    "jobwatch.marks.v3": {x: {s: "applied", t: T0S - 1000, h}, y: {s: "seen", t: T0S - 900}},
    "jobwatch.migrated.v3": {at: 1, check: false},
  });
  const gh = makeGitHub({files: {"status.json": {x: {s: "oa"}, y: {s: "seen"}}}});     // an old page stripped t/h and moved x to oa
  const {sync, clock, events} = boot({storage, gh});
  await sync.pull("boot");
  const expected = {s: "oa", h: [...h, {s: "oa", t: null}]};
  assert.deepEqual(sync.marks.x, expected, "case 6: t-less remote change adopted, history carried forward");
  assert.deepEqual(sync.marks.y, {s: "seen", t: T0S - 900}, "equal value ⇒ local t kept");
  assert.deepEqual(storage.json("jobwatch.marks.v3").x, expected, "persisted verdict");
  assert.deepEqual(events.marks, [["x"]]);
  clock.jump(5000);
  sync.commit("z", {s: "seen"});
  await clock.advance(3000);
  assert.equal(gh.file("status.json").x.s, "oa", "the other writer's edit survives our push");
  assert.deepEqual(gh.file("status.json").x.h, expected.h);
  await sync.pull("later");
  assert.deepEqual(sync.marks.x, expected);
  assert.equal(storage.json("jobwatch.trash.v1").length, 1, "stashed once, no per-cycle churn");
});

test("tie_same_t_adopts_remote", async () => {
  const storage = makeStorage({"jobwatch.marks.v3": {x: {s: "applied", t: T0S - 5}}, "jobwatch.migrated.v3": {at: 1, check: false}});
  const {sync} = boot({storage, gh: makeGitHub({files: {"status.json": {x: {s: "oa", t: T0S - 5}}}})});
  await sync.pull();
  assert.deepEqual(sync.marks.x, {s: "oa", t: T0S - 5}, "case 5 tie, local clean ⇒ remote");
  assert.deepEqual(storage.json("jobwatch.marks.v3").x, {s: "oa", t: T0S - 5});
  assert.deepEqual(storage.json("jobwatch.trash.v1").map((t) => t.why), ["lww-loser"]);
});

test("reset_drops_future_stamped_entry", async () => {
  const storage = makeStorage({
    "jobwatch.marks.v3": {x: {s: "applied", t: T0S + 300}, y: {s: "applied", t: T0S - 300}},   // x was stamped by a device whose clock runs ahead
    "jobwatch.migrated.v3": {at: 1, check: false},
  });
  const {sync, events} = boot({storage, gh: makeGitHub({files: {"status.json": {}}})});
  await sync.pull("boot");
  assert.deepEqual(sync.marks, {}, "a repo reset takes regardless of t");
  assert.deepEqual(storage.json("jobwatch.marks.v3"), {});
  assert.deepEqual(events.marks, [["x", "y"]]);
  await sync.pull("again");
  assert.deepEqual(sync.marks, {}, "nothing flashes back on later pulls");
  assert.equal(storage.json("jobwatch.trash.v1").length, 2);
});

test("commit_on_future_stamped_entry_sticks", async () => {
  const remote = {x: {s: "oa", t: T0S + 120, h: [{s: "oa", t: T0S + 120}]}};           // the other device's clock is 2 min ahead
  const fast = boot({storage: makeStorage({"jobwatch.migrated.v3": {at: 1, check: false}}), gh: makeGitHub({files: {"status.json": remote}})});
  await fast.sync.pull();
  const before = fast.events.marks.length;
  assert.equal(fast.sync.commit("x", {s: "interview"}).s, "oa");
  assert.equal(fast.sync.marks.x.s, "interview", "the click is not undone by this tab's own disk copy");
  assert.equal(fast.sync.marks.x.t, T0S + 121, "stamped after the entry it replaces, not at the slow local now");
  assert.deepEqual(fast.sync.marks.x.h.map((i) => i.s), ["oa", "interview"]);
  assert.equal(fast.events.marks.length, before + 1);
  await fast.clock.advance(3000);
  assert.equal(fast.gh.file("status.json").x.s, "interview", "and it wins the LWW at push time");
  assert.equal(fast.gh.commits, 1);
  assert.equal(fast.sync.dirty.size, 0);
  assert.equal(fast.storage.json("jobwatch.trash.v1"), undefined, "nothing was trashed");

  const slow = boot({                                                                    // same thing seen from a device whose own clock is 3 min behind
    storage: makeStorage({"jobwatch.migrated.v3": {at: 1, check: false}}), clock: makeClock(T0 - 180000),
    gh: makeGitHub({files: {"status.json": {x: {s: "oa", t: T0S - 60}}}}),
  });
  await slow.sync.pull();
  slow.sync.commit("x", {s: "interview"});
  assert.equal(slow.sync.marks.x.t, T0S - 59);
  await slow.clock.advance(3000);
  assert.equal(slow.gh.file("status.json").x.s, "interview");
  assert.equal(slow.sync.marks.x.s, "interview");
  assert.equal(slow.storage.json("jobwatch.trash.v1"), undefined);
  const plain = boot();
  plain.sync.commit("x", {s: "applied"});
  assert.equal(plain.sync.marks.x.t, T0S, "an ordinary commit is stamped at now (no bump when prev is not in the future)");
});

test("boot_tolerates_non_array_dirty_list", () => {
  for (const bad of ['{"a":1}', "5", "null", '"x"']) {
    const storage = makeStorage({"jobwatch.marks.v3": {a: {s: "applied", t: 1}}, "jobwatch.migrated.v3": {at: 1, check: false}});
    storage.set("jobwatch.dirty.v1", bad);
    const {sync, events} = boot({storage});
    assert.equal(sync.dirty.size, 0, `dirty.v1=${bad} boots`);
    assert.ok(events.logs.some((l) => /^warn: dirty.v1/.test(l)));
    assert.deepEqual(sync.absorbDisk(), [], "the storage-event path tolerates it too");
    sync.commit("b", {s: "seen"});
    assert.deepEqual(storage.json("jobwatch.dirty.v1"), ["b"], "rewritten as a list on the next change");
  }
  const storage = makeStorage({"jobwatch.marks.v3": {a: {s: "applied", t: 1}}, "jobwatch.dirty.v1": ["a", 7, null], "jobwatch.migrated.v3": {at: 1, check: false}});
  assert.deepEqual([...boot({storage}).sync.dirty], ["a"], "non-string members are dropped");
});

/* ------------------------------------------------------------------ push (§10.4.5) */

test("ack_removes_id_from_persisted_dirty", async () => {
  const {sync, storage, gh} = boot();
  sync.commit("a", {s: "applied"});
  assert.deepEqual(storage.json("jobwatch.dirty.v1"), ["a"]);
  await sync.flushNow();
  assert.deepEqual(storage.json("jobwatch.dirty.v1"), []);
  assert.equal(sync.dirty.size, 0);
  assert.deepEqual(gh.file("status.json"), {a: {h: [{s: "applied", t: T0S}], s: "applied", t: T0S}});
  assert.equal(gh.commits, 1);
  assert.equal(gh.count(isPut("status.json")), 1);
  assert.ok(gh.calls.find(isPut("status.json")).body.sha === undefined, "file did not exist: PUT without sha");
});

test("push_ack_shrinks_persisted_dirty", async () => {
  const {sync, storage, gh, clock} = boot({gh: makeGitHub({files: {"status.json": {z: {s: "seen", t: 1}}}})});
  sync.commit("a", {s: "applied"});
  sync.commit("b", {star: true});
  assert.deepEqual(storage.json("jobwatch.dirty.v1"), ["a", "b"]);
  assert.equal(gh.calls.length, 0, "debounced: nothing sent yet");
  await clock.advance(1999);
  assert.equal(gh.calls.length, 0);
  await clock.advance(1);
  assert.deepEqual(storage.json("jobwatch.dirty.v1"), []);
  assert.deepEqual(Object.keys(gh.file("status.json")), ["a", "b", "z"], "sorted keys, remote entry kept");
  assert.ok(gh.calls.find(isPut("status.json")).body.sha, "existing file: PUT carries the sha just read");
  assert.equal(gh.commits, 1);
});

test("reboot_after_ack_does_not_push", async () => {
  const {sync, storage, gh, clock} = boot();
  sync.commit("a", {s: "applied"});
  await sync.flushNow();
  const calls = gh.calls.length;
  const second = boot({storage, gh, clock}).sync;
  assert.equal(second.dirty.size, 0);
  assert.deepEqual(second.marks, sync.marks);
  second.schedulePush();
  await clock.advance(60000);
  assert.equal(gh.calls.length, calls, "zero fetches");
});

test("push_value_snapshot_keeps_inflight_edit_dirty", async () => {
  const {sync, gh, clock, storage} = boot();
  let release;
  gh.once(isPut("status.json"), (req) => new Promise((r) => { release = () => r(gh.route(req)); }));
  sync.commit("a", {s: "applied"});
  const inflight = sync.flushNow();
  await clock.settle();
  assert.equal(sync.health.state, "busy");
  clock.jump(1000);
  sync.commit("a", {s: "oa"});
  sync.commit("b", {s: "seen"});
  release();
  await inflight;
  assert.deepEqual([...sync.dirty].sort(), ["a", "b"], "the click during the PUT stays dirty");
  assert.equal(sync.marks.a.s, "oa", "in-memory edit never reverted");
  assert.equal(gh.file("status.json").a.s, "applied", "first PUT carried the snapshot value");
  assert.deepEqual(storage.json("jobwatch.dirty.v1").sort(), ["a", "b"]);
  await clock.advance(2000);
  assert.equal(gh.file("status.json").a.s, "oa");
  assert.equal(gh.file("status.json").b.s, "seen");
  assert.equal(sync.dirty.size, 0);
});

test("push_toggle_back_during_put_keeps_newer_entry_dirty", async () => {
  // S06: the ack compares whole entries, not just s/star/note — a stage toggled away and back during the PUT has a
  // newer t and a longer h, so it must stay dirty and reach the repo with the next PUT.
  const {sync, gh, clock} = boot();
  let release;
  gh.once(isPut("status.json"), (req) => new Promise((r) => { release = () => r(gh.route(req)); }));
  sync.commit("a", {s: "applied"});
  const inflight = sync.flushNow();
  await clock.settle();
  clock.jump(1000);
  sync.commit("a", {s: "oa"});
  clock.jump(1000);
  sync.commit("a", {s: "applied"});
  release();
  await inflight;
  assert.deepEqual([...sync.dirty], ["a"], "same stage as the snapshot but a newer entry ⇒ still dirty");
  assert.equal(gh.file("status.json").a.t, T0S, "first PUT carried the snapshot entry");
  await clock.advance(2000);
  const final = gh.file("status.json").a;
  assert.equal(final.s, "applied");
  assert.equal(final.t, T0S + 2, "the second PUT carried the newer t");
  assert.deepEqual(final.h.map((x) => x.s), ["applied", "oa", "applied"], "the full history reached the repo");
  assert.equal(sync.dirty.size, 0);
});

test("lww_loser_is_acked_after_put", async () => {
  const remote = {a: {s: "oa", t: T0S + 100}};
  const {sync, gh} = boot({gh: makeGitHub({files: {"status.json": remote}})});
  sync.commit("a", {s: "applied"});
  await sync.flushNow();
  assert.equal(sync.marks.a.s, "oa", "newer remote wins");
  assert.equal(sync.dirty.size, 0, "the loser is acked, not left dirty");
  assert.equal(gh.count(isPut("status.json")), 0, "merged body equals remote ⇒ no PUT");
  assert.equal(sync.health.state, "on");
});

test("push_noop_put_skipped_when_remote_equal", async () => {
  const remote = {a: {h: [{s: "applied", t: 5}], s: "applied", t: 5}};
  const storage = makeStorage({"jobwatch.marks.v3": remote, "jobwatch.dirty.v1": ["a"], "jobwatch.migrated.v3": {at: 1, check: false}});
  const {sync, gh} = boot({storage, gh: makeGitHub({files: {"status.json": remote}})});
  assert.equal(sync.dirty.size, 1);
  await sync.flushNow();
  assert.equal(gh.count(isPut("status.json")), 0);
  assert.equal(gh.commits, 0);
  assert.equal(sync.dirty.size, 0);
  assert.deepEqual(storage.json("jobwatch.dirty.v1"), []);
  assert.equal(sync.health.state, "on");
});

test("push_409_regets_and_succeeds", async () => {
  const {sync, gh, clock, events} = boot({gh: makeGitHub({files: {"status.json": {}}})});
  gh.once(isPut("status.json"), () => res(409, {message: "status.json does not match"}));
  sync.commit("a", {s: "applied"});
  const p = sync.flushNow();
  await clock.advance(1000);
  await p;
  assert.deepEqual(gh.calls.map((c) => c.method), ["GET", "PUT", "GET", "PUT"]);
  assert.equal(gh.file("status.json").a.s, "applied");
  assert.equal(sync.dirty.size, 0);
  assert.equal(sync.health.state, "on");
  assert.ok(!events.banners.some(([id, p]) => id === "sync-err" && p), "409 never shows the error banner");
});

test("push_401_keeps_dirty_and_stops", async () => {
  const {sync, gh, clock, events, banner} = boot({pat: "ghp_revoked"});
  sync.commit("a", {s: "applied"});
  await clock.advance(2000);
  assert.equal(gh.calls.length, 1);
  assert.equal(sync.health.state, "err");
  assert.equal(sync.health.halted, true);
  assert.match(sync.health.err, /Token invalid or expired/);
  assert.match(banner("sync-err").at(-1), /Token invalid/);
  assert.ok(sync.dirty.has("a"));
  sync.commit("b", {s: "seen"});
  await clock.advance(60000);
  assert.equal(gh.calls.length, 1, "zero further fetches while halted");
  sync.setPat(PAT);
  assert.equal(sync.health.halted, false);
  assert.equal(gh.calls.length, 1, "a new token alone does not push");
  await sync.retry();
  assert.equal(sync.dirty.size, 0);
  assert.equal(sync.health.state, "on");
  assert.equal(banner("sync-err").at(-1), null, "banner cleared");
  assert.deepEqual(Object.keys(gh.file("status.json")), ["a", "b"]);
  assert.ok(events.health.includes("err"));
});

test("offline_push_waits_for_online", async () => {
  const net = {online: false};
  const {sync, gh, clock, banner} = boot({online: () => net.online});
  sync.commit("a", {s: "applied"});
  await clock.advance(2000);
  assert.equal(gh.calls.length, 0, "no request while offline");
  assert.equal(sync.health.state, "pending");
  assert.equal(sync.health.reason, "offline");
  assert.equal(sync.health.halted, true);
  assert.deepEqual(banner("pending-offline").at(-1), {n: 1});
  sync.commit("b", {s: "seen"});
  await clock.advance(120000);
  assert.equal(gh.calls.length, 0, "dirty grows, nothing burns retries");
  assert.equal(sync.dirty.size, 2);
  net.online = true;
  await sync.retry();
  assert.equal(sync.dirty.size, 0);
  assert.equal(sync.health.state, "on");
  assert.equal(banner("pending-offline").at(-1), null);
  assert.deepEqual(Object.keys(gh.file("status.json")), ["a", "b"]);
});

test("push_transient_exhaustion_retries_after_60s", async () => {
  const {sync, gh, clock, banner} = boot({gh: makeGitHub({files: {"status.json": {}}})});
  for (let i = 0; i < 6; i++) gh.once(isGet("status.json"), () => res(503, {message: "unavailable"}));
  sync.commit("a", {s: "applied"});
  const p = sync.flushNow();
  await clock.advance(31000);
  await p;
  assert.equal(gh.count(isGet("status.json")), 6, "1+2+4+8+16 s backoff, 6 attempts");
  assert.equal(sync.health.state, "pending");
  assert.equal(sync.health.reason, "exhausted");
  assert.equal(sync.health.halted, false);
  assert.ok(sync.dirty.has("a"));
  assert.deepEqual(banner("pending-retry").at(-1), {n: 1}, "§10.4.7 pending row: the user is told GitHub is not answering");
  await clock.advance(59999);
  assert.equal(gh.count(isGet("status.json")), 6);
  await clock.advance(1);
  assert.equal(sync.dirty.size, 0, "retried after 60 s and succeeded");
  assert.equal(sync.health.state, "on");
  assert.equal(gh.file("status.json").a.s, "applied");
  assert.equal(banner("pending-retry").at(-1), null, "banner cleared by the successful retry");

  const net = {online: true};
  const second = boot({gh: makeGitHub({files: {"status.json": {}}}), online: () => net.online});
  for (let i = 0; i < 6; i++) second.gh.once(isGet("status.json"), () => res(503, {}));
  second.sync.commit("a", {s: "applied"});
  const p2 = second.sync.flushNow();
  await second.clock.advance(31000);
  await p2;
  assert.deepEqual(second.banner("pending-retry").at(-1), {n: 1});
  net.online = false;
  await second.clock.advance(60000);
  assert.equal(second.banner("pending-retry").at(-1), null, "going offline replaces the retry banner with the offline one");
  assert.deepEqual(second.banner("pending-offline").at(-1), {n: 1});
});

test("push_before_first_pull_does_not_drop_legacy", async () => {
  const storage = makeStorage({"jobwatch.marks.v2": {a: "applied", b: {s: "dropped"}}});
  const gh = makeGitHub({files: {"status.json": {}}});
  const {sync, banner} = boot({storage, gh});
  assert.equal(sync.migrationCheck().pending, true);
  sync.commit("c", {s: "seen"});
  await sync.flushNow();
  assert.deepEqual(Object.keys(sync.marks).sort(), ["a", "b", "c"], "legacy marks survive a push before the orphan check");
  assert.deepEqual(Object.keys(gh.file("status.json")), ["a", "b", "c"]);
  assert.equal(storage.json("jobwatch.trash.v1"), undefined);
  await sync.pull();
  assert.deepEqual(banner("local-orphans"), [], "nothing is orphaned any more");
  assert.equal(sync.migrationCheck().pending, false);
});

test("push_while_orphans_pending_excludes_them", async () => {
  const storage = makeStorage({"jobwatch.marks.v2": {a: "applied", b: {s: "dropped"}, c: {s: "seen", star: true}}});
  const gh = makeGitHub({files: {"status.json": {}}});                                  // the repo was reset
  const {sync, clock, banner} = boot({storage, gh});
  await sync.pull("boot");
  assert.deepEqual(sync.migrationCheck(), {pending: true, orphans: ["a", "b", "c"]});
  sync.commit("new1", {s: "seen"});                                                       // a click on an unrelated role while the banner is up
  await clock.advance(3000);
  assert.deepEqual(Object.keys(gh.file("status.json")), ["new1"], "unanswered orphans are neither trashed nor published");
  assert.deepEqual(Object.keys(sync.marks).sort(), ["a", "b", "c", "new1"]);
  assert.equal(sync.dirty.size, 0);
  assert.equal(sync.migrationCheck().pending, true, "the banner is still the only way to answer");
  sync.commit("a", {s: "oa"});                                                            // editing an orphan answers the question for that id: keep
  await clock.advance(3000);
  assert.deepEqual(Object.keys(gh.file("status.json")), ["a", "new1"]);
  assert.deepEqual(sync.migrationCheck().orphans, ["b", "c"]);
  banner("local-orphans")[0].discard();
  assert.deepEqual(Object.keys(sync.marks).sort(), ["a", "new1"]);
  assert.deepEqual(storage.json("jobwatch.trash.v1").map((t) => [t.id, t.why]), [["b", "discarded"], ["c", "discarded"]]);
  await sync.pull("next");
  assert.deepEqual(Object.keys(sync.marks).sort(), ["a", "new1"], "Discard is not undone by a re-import from the repo");
  assert.deepEqual(Object.keys(gh.file("status.json")), ["a", "new1"]);
});

test("second_tab_adopts_migration_answer", async () => {
  const viaStorageEvent = async (tab1, tab2) => {
    tab1.banner("local-orphans")[0].discard();
    assert.deepEqual(tab2.sync.absorbDisk(), [], "storage event in tab 2");
    assert.equal(tab2.banner("local-orphans").at(-1), null, "tab 2's copy of the banner is taken down");
  };
  const viaPull = async (tab1, tab2) => {
    tab1.banner("local-orphans")[0].discard();
    await tab2.sync.pull("focus");
    assert.equal(tab2.banner("local-orphans").length, 2, "not re-asked");
    assert.equal(tab2.banner("local-orphans").at(-1), null);
  };
  for (const answerReaches of [viaStorageEvent, viaPull]) {
    const storage = makeStorage({"jobwatch.marks.v2": {a: "applied", b: {s: "dropped"}}});
    const gh = makeGitHub({files: {"status.json": {}}});
    const t1 = boot({storage, gh});
    const t2 = boot({storage, gh, clock: t1.clock});
    await t1.sync.pull("boot");
    await t2.sync.pull("boot");
    assert.equal(t1.banner("local-orphans").length, 1);
    assert.equal(t2.banner("local-orphans").length, 1);
    await answerReaches(t1, t2);
    assert.equal(t2.sync.migrationCheck().pending, false, "the flag is per device: tab 2 sees tab 1's answer");
    t2.sync.commit("n", {s: "seen"});
    await t1.clock.advance(3000);
    assert.deepEqual(Object.keys(gh.file("status.json")), ["n"], "tab 2 does not publish what tab 1 discarded");
    assert.deepEqual(Object.keys(t2.sync.marks), ["n"], "tab 2's authoritative merge applied the answer");
    assert.deepEqual(Object.keys(storage.json("jobwatch.marks.v3")), ["n"]);
    t1.sync.absorbDisk();
    await t1.sync.pull("refresh");
    assert.deepEqual(Object.keys(t1.sync.marks), ["n"]);
    assert.equal(gh.commits, 1);
  }
});

test("push_never_replaces_marks_with_snapshot", async () => {
  const {sync, gh, clock} = boot({gh: makeGitHub({files: {"status.json": {r: {s: "seen", t: 1}}}})});
  const marksRef = sync.marks;
  const dirtyRef = sync.dirty;
  const healthRef = sync.health;
  sync.commit("a", {s: "applied"});
  await sync.flushNow();
  await sync.pull();
  gh.set("status.json", {});
  await sync.pull();
  sync.clearLocal();
  assert.equal(sync.marks, marksRef, "marks object identity never changes");
  assert.equal(sync.dirty, dirtyRef);
  assert.equal(sync.health, healthRef);
  await clock.advance(5000);
  assert.equal(sync.marks, marksRef);
});

/* ------------------------------------------------------------------ pull (§10.4.4) */

test("pull_drops_remote_deleted_clean_entry", async () => {
  const storage = makeStorage({"jobwatch.marks.v3": {a: {s: "applied", t: T0S - 50}}, "jobwatch.migrated.v3": {at: 1, check: false}});
  const {sync, events, storage: s} = boot({storage, gh: makeGitHub({files: {"status.json": {}}})});
  await sync.pull();
  assert.deepEqual(sync.marks, {});
  assert.deepEqual(events.marks, [["a"]]);
  assert.deepEqual(s.json("jobwatch.trash.v1").map((x) => [x.id, x.why]), [["a", "remote-deleted"]]);
});

test("pull_keeps_dirty_local_only", async () => {
  const storage = makeStorage({"jobwatch.marks.v3": {a: {s: "applied", t: T0S - 50}}, "jobwatch.dirty.v1": ["a"], "jobwatch.migrated.v3": {at: 1, check: false}});
  const {sync, gh, clock} = boot({storage, gh: makeGitHub({files: {"status.json": {}}})});
  await sync.pull();
  assert.equal(sync.marks.a.s, "applied");
  assert.equal(gh.count(isPut("status.json")), 0);
  await clock.advance(500);
  assert.equal(gh.file("status.json").a.s, "applied", "a pull with dirty ids schedules a push in 500 ms");
  assert.equal(sync.dirty.size, 0);
});

test("pull_answer_older_than_put_is_discarded", async () => {
  const storage = makeStorage({"jobwatch.migrated.v3": {at: 1, check: false}});
  const gh = makeGitHub({files: {"status.json": {}}});
  const {sync, clock, events} = boot({storage, gh});
  let release;                                                                              // the boot pull's GET is slow and answers with the pre-PUT content
  gh.once(isGet("status.json"), (req) => new Promise((r) => { const answer = gh.route(req); release = () => r(answer); }));
  const pull = sync.pull("boot");
  await clock.advance(500);
  sync.commit("x", {s: "applied"});                                                         // click while the pull is in flight
  await clock.advance(3000);                                                                // push: fresh GET + PUT + ack
  assert.equal(gh.file("status.json").x.s, "applied");
  assert.equal(sync.dirty.size, 0);
  release();
  await pull;
  assert.equal(sync.marks.x?.s, "applied", "a stale pull answer must not case-3 the mark that was just PUT");
  assert.equal(storage.json("jobwatch.trash.v1"), undefined);
  assert.deepEqual(events.marks, [["x"]], "no flip back to todo");
  assert.ok(events.logs.some((l) => /pull skipped \(boot\): superseded by a push/.test(l)));
  assert.equal(sync.health.state, "on");
  await sync.pull("later");
  assert.equal(sync.marks.x.s, "applied");
  assert.ok(events.logs.some((l) => /pull ok \(later\)/.test(l)), "later pulls are not affected");
});

test("pull_404_keeps_all", async () => {
  const storage = makeStorage({"jobwatch.marks.v3": {a: {s: "applied", t: T0S - 50}, b: {s: "seen"}}, "jobwatch.migrated.v3": {at: 1, check: false}});
  const {sync, gh, storage: s} = boot({storage});
  await sync.pull();
  assert.deepEqual(Object.keys(sync.marks).sort(), ["a", "b"]);
  assert.equal(s.json("jobwatch.trash.v1"), undefined);
  assert.equal(sync.health.state, "on");
  sync.commit("c", {s: "oa"});
  await sync.flushNow();
  assert.deepEqual(Object.keys(gh.file("status.json")), ["a", "b", "c"], "PUT without sha creates the file");
});

test("pull_mirror_not_authoritative", async () => {
  const storage = makeStorage({"jobwatch.marks.v3": {a: {s: "applied", t: T0S - 50}}, "jobwatch.migrated.v3": {at: 1, check: false}});
  const gh = makeGitHub({pages: {"status.json": {b: {s: "seen", t: 7}}}});
  const {sync, banner, clock} = boot({storage, gh, pat: null});
  assert.equal(sync.health.state, "mirror");
  await sync.pull();
  assert.deepEqual(Object.keys(sync.marks).sort(), ["a", "b"], "local kept, remote imported");
  assert.deepEqual(banner("mirror"), [{n: 1}]);
  assert.equal(gh.count(isApi), 0, "a PAT-less page never touches api.github.com");
  assert.match(gh.calls[0].url, /^status\.json\?ts=\d+$/);
  sync.commit("c", {s: "seen"});
  await clock.advance(5000);
  assert.equal(gh.count(isApi), 0, "no push without a token");
  assert.ok(sync.dirty.has("c"), "stays dirty until a token exists");
});

test("pull_corrupt_remote_is_error_and_no_put", async () => {
  const gh = makeGitHub({files: {"status.json": "{not json"}});
  const {sync, banner} = boot({gh});
  sync.commit("a", {s: "applied"});
  await sync.pull();
  assert.equal(sync.health.state, "err");
  assert.match(banner("sync-err").at(-1), /not valid JSON/);
  await sync.flushNow();
  assert.equal(gh.count(isPut("status.json")), 0, "corrupt remote ⇒ no PUT");
  assert.equal(sync.health.halted, true);
  assert.ok(sync.dirty.has("a"));
});

test("migration_orphans_banner_push_and_discard", async () => {
  const legacy = {a: {s: "applied"}, b: {s: "dropped"}, c: {s: "seen", star: true}};
  const remote = {a: {s: "applied"}};
  const storage = makeStorage({"jobwatch.marks.v2": legacy});
  const gh = makeGitHub({files: {"status.json": remote}});
  const {sync, banner, clock} = boot({storage, gh});
  assert.deepEqual(sync.marks, legacy, "v2 copied through parseMarks, no t invented");
  assert.equal(storage.json("jobwatch.marks.v2") !== undefined, true, "v2 left intact");
  await sync.pull();
  const [payload] = banner("local-orphans");
  assert.equal(payload.n, 2);
  assert.deepEqual(payload.ids, ["b", "c"]);
  assert.equal(sync.dirty.size, 0);
  payload.push();
  assert.deepEqual([...sync.dirty].sort(), ["b", "c"]);
  assert.equal(sync.migrationCheck().pending, false);
  await clock.advance(2000);
  assert.deepEqual(Object.keys(gh.file("status.json")), ["a", "b", "c"]);
  assert.equal(sync.dirty.size, 0);
  await sync.pull();
  assert.equal(banner("local-orphans").length, 1, "banner is one-time");

  const storage2 = makeStorage({"jobwatch.marks.v2": legacy});
  const gh2 = makeGitHub({files: {"status.json": remote}});
  const second = boot({storage: storage2, gh: gh2});
  await second.sync.pull();
  second.banner("local-orphans")[0].discard();
  assert.deepEqual(Object.keys(second.sync.marks), ["a"]);
  assert.equal(gh2.commits, 0);
  await second.sync.pull();
  assert.deepEqual(Object.keys(second.sync.marks), ["a"]);
});

test("clearLocal_does_not_reimport_v2", async () => {
  const storage = makeStorage({"jobwatch.marks.v2": {a: "applied"}});
  const {sync} = boot({storage});
  assert.deepEqual(Object.keys(sync.marks), ["a"]);
  sync.commit("b", {s: "seen"});
  sync.clearLocal();
  assert.deepEqual(sync.marks, {});
  assert.equal(sync.dirty.size, 0);
  assert.equal(storage.get("jobwatch.marks.v3"), "{}");
  assert.equal(storage.get("jobwatch.dirty.v1"), "[]");
  assert.equal(storage.json("jobwatch.migrated.v3").check, false, "flag kept, check answered");
  assert.deepEqual(storage.json("jobwatch.marks.v2"), {a: "applied"}, "v2 untouched");
  const again = boot({storage}).sync;
  assert.deepEqual(again.marks, {}, "the stale v2 snapshot is not re-imported");
  assert.equal(again.migrationCheck().pending, false);
});

test("undo_restores_h_verbatim", () => {
  const {sync, clock} = boot();
  sync.commit("a", {s: "applied"});
  clock.jump(60000);
  const prev = sync.commit("a", {s: "dropped"});
  assert.deepEqual(sync.marks.a.h.map((x) => x.s), ["applied", "dropped"]);
  clock.jump(1000);
  sync.commit("a", prev, {restore: true});
  assert.equal(sync.marks.a.s, "applied");
  assert.deepEqual(sync.marks.a.h, [{s: "applied", t: T0S}], "not [applied, dropped, applied]");
  assert.equal(sync.marks.a.t, T0S + 61, "fresh t for LWW");
  assert.ok(sync.dirty.has("a"));
  const before = sync.commit("z", {s: "seen"});
  assert.equal(before, null);
  sync.commit("z", null);
  assert.deepEqual(sync.marks.z, {d: T0S + 61}, "undo of a first mark tombstones it");
});

/* ------------------------------------------------------------------ list files (§10.4.6) */

test("saveList_add_remove_set_rmw", async () => {
  const gh = makeGitHub({files: {"companies.json": ["tiktok"], "manual.json": []}});
  const {sync} = boot({gh});
  await sync.getFile("companies.json");
  await sync.getFile("manual.json");
  await sync.getFile("config.json");
  assert.deepEqual(await sync.saveList("companies.json", {add: "d-Matrix"}), ["d matrix", "tiktok"], "normalised + sorted");
  gh.set("companies.json", ["anduril", "tiktok"]);
  assert.deepEqual(await sync.saveList("companies.json", {add: "Cerebras"}), ["anduril", "cerebras", "tiktok"], "delta on the fresh remote, never a blind overwrite");
  assert.deepEqual(await sync.saveList("companies.json", {add: "TikTok"}), ["anduril", "cerebras", "tiktok"], "duplicate add is a no-op");
  assert.deepEqual(await sync.saveList("companies.json", {remove: "tiktok"}), ["anduril", "cerebras"]);
  const role = {id: "manual:1", company: "Acme", title: "SWE"};
  assert.deepEqual(await sync.saveList("manual.json", {add: role}, (x) => x.id), [role]);
  assert.deepEqual(await sync.saveList("manual.json", {remove: {id: "manual:1"}}, (x) => x.id), []);
  assert.deepEqual(await sync.saveList("config.json", {set: {max_age_days: 90}}), {max_age_days: 90});
  assert.deepEqual(gh.file("config.json"), {max_age_days: 90}, "404 ⇒ created");
  await assert.rejects(sync.saveList("config.json", {set: {max_age_days: 0}}), (e) => e.name === "UIError" && /max_age_days/.test(e.message));
  assert.deepEqual(gh.file("config.json"), {max_age_days: 90}, "invalid config never written");
  assert.deepEqual(await sync.saveList("config.json", {set: {max_age_days: 45, custom_key: true}}), {max_age_days: 45, custom_key: true}, "unknown keys kept");
  gh.set("companies.json", ["only"]);
  await assert.rejects(sync.saveList("companies.json", {remove: "only"}), /Track nothing/);
  assert.deepEqual(gh.file("companies.json"), ["only"]);
  assert.equal(await sync.saveList("companies.json", {remove: "only"}, undefined, {confirmEmpty: async () => false}), null);
  assert.deepEqual(gh.file("companies.json"), ["only"]);
  assert.deepEqual(await sync.saveList("companies.json", {remove: "only"}, undefined, {confirmEmpty: async () => true}), []);
  assert.deepEqual(gh.file("companies.json"), []);
  const messages = gh.calls.filter((c) => c.method === "PUT").map((c) => c.body.message);
  assert.ok(messages.includes("jobwatch: update tracked companies") && messages.includes("jobwatch: update manual roles") && messages.includes("jobwatch: update config"));
});

test("saveList_refuses_when_not_loaded", async () => {
  const {sync, gh} = boot({gh: makeGitHub({files: {"companies.json": ["tiktok"]}})});
  await assert.rejects(sync.saveList("companies.json", {add: "x"}), (e) => e.name === "UIError" && /has not loaded yet/.test(e.message));
  assert.equal(gh.calls.length, 0);
  const noPat = boot({pat: null, gh: makeGitHub()}).sync;
  await assert.rejects(noPat.saveList("companies.json", {add: "x"}), (e) => e.name === "UIError" && /Turn on Sync/.test(e.message));
  gh.once(isGet("companies.json"), () => res(500, {message: "boom"}));
  await assert.rejects(sync.getFile("companies.json"), (e) => e.status === 500);
  await assert.rejects(sync.saveList("companies.json", {add: "x"}), /has not loaded yet/, "a failed load does not count as loaded");
});

test("saveList_409_retry", async () => {
  const gh = makeGitHub({files: {"companies.json": ["tiktok"]}});
  const {sync} = boot({gh});
  await sync.getFile("companies.json");
  gh.once(isPut("companies.json"), () => res(409, {message: "does not match"}));
  assert.deepEqual(await sync.saveList("companies.json", {add: "zoox"}), ["tiktok", "zoox"]);
  assert.deepEqual(gh.calls.map((c) => c.method), ["GET", "GET", "PUT", "GET", "PUT"]);
  gh.once(isPut("companies.json"), () => res(409, {}));
  gh.once(isPut("companies.json"), () => res(409, {}));
  gh.once(isPut("companies.json"), () => res(409, {}));
  await assert.rejects(sync.saveList("companies.json", {add: "rivian"}), (e) => e.status === 409, "gives up after 3 attempts");
});

test("saveList_remove_matches_non_canonical_stored_keyword", async () => {
  const gh = makeGitHub({files: {"companies.json": ["d-matrix", "TikTok", "tiktok"]}});   // hand-edited file: not norm()-canonical
  const {sync} = boot({gh});
  await sync.getFile("companies.json");
  assert.deepEqual(await sync.saveList("companies.json", {remove: "d matrix"}, (x) => x), ["tiktok"], "the chip the user sees is what is removed");
  assert.deepEqual(gh.file("companies.json"), ["tiktok"]);
  assert.equal(gh.commits, 1);
  gh.set("companies.json", ["d-matrix"]);
  assert.deepEqual(await sync.saveList("companies.json", {add: "D-Matrix"}, (x) => x), ["d matrix"], "re-adding a stored keyword in another spelling never duplicates it");
});

/* ------------------------------------------------------------------ verify (§10.15) */

test("verify_write_probe_409_writable_403_not", async () => {
  const gh = makeGitHub({files: {"status.json": {a: {s: "applied"}}}});
  const {sync} = boot({gh, pat: null});
  const ok = await sync.verify(REPO, PAT);
  assert.deepEqual(ok, {ok: true, write: true, defaultBranch: "main"});
  gh.once(isPut("status.json"), () => res(403, {message: "Resource not accessible by personal access token"}));
  const ro = await sync.verify(REPO, PAT);
  assert.equal(ro.ok, false);
  assert.equal(ro.write, false);
  assert.match(ro.reason, /Contents: Read and write/);
  const bad = await sync.verify(REPO, "ghp_nope");
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /Token invalid/);
  const missing = await boot({gh: makeGitHub(), pat: null}).sync.verify(REPO, PAT);
  assert.deepEqual([missing.ok, missing.write], [true, null]);
  assert.match(missing.reason, /first change/);
  const wrongRepo = await sync.verify("someone/else", PAT);
  assert.equal(wrongRepo.ok, false);
  assert.match(wrongRepo.reason, /not found/);
  assert.match((await sync.verify("nonsense", PAT)).reason, /owner\/repo/);
  gh.once(isPut("status.json"), () => res(422, {message: "weird"}));
  const odd = await sync.verify(REPO, PAT);
  assert.deepEqual([odd.ok, odd.write], [true, null], "anything else ⇒ write unknown, never claimed");
});

test("verify_no_commit", async () => {
  const gh = makeGitHub({files: {"status.json": {a: {s: "applied"}}}});
  const before = {content: gh.store.get("status.json").content, sha: gh.sha("status.json")};
  const {sync, storage} = boot({gh, pat: null});
  await sync.verify(REPO, PAT);
  const probe = gh.calls.find(isPut("status.json"));
  assert.equal(probe.body.sha, "0".repeat(40));
  assert.equal(dec(probe.body.content), before.content, "the bytes just read are sent back");
  assert.equal(gh.commits, 0);
  assert.equal(gh.sha("status.json"), before.sha);
  assert.equal(storage.get("jobwatch.gh.pat"), null, "verify stores nothing");
});

/* ------------------------------------------------------------------ health (§10.4.7) */

test("health_transitions", async () => {
  const {sync, events, gh, clock} = boot({gh: makeGitHub({files: {"status.json": {}}})});
  assert.equal(sync.health.state, "on");
  sync.commit("a", {s: "applied"});
  assert.equal(sync.health.pending, 1);
  let release;
  gh.once(isPut("status.json"), (req) => new Promise((r) => { release = () => r(gh.route(req)); }));
  const p = sync.flushNow();
  await clock.settle();
  assert.equal(sync.health.state, "busy");
  release();
  await p;
  assert.equal(sync.health.state, "on");
  assert.equal(sync.health.okAt, T0);
  assert.equal(sync.health.pending, 0);
  assert.ok(events.health.includes("busy"));

  gh.once(isGet("status.json"), () => res(403, {message: "forbidden"}, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": String(T0S + 1800)}));
  sync.commit("b", {s: "seen"});
  await sync.flushNow();
  assert.equal(sync.health.state, "err");
  assert.equal(sync.health.code, 403);
  assert.match(sync.health.err, /API limit reached — retry after \d\d:\d\d/);
  await sync.pull();
  assert.equal(sync.health.state, "err", "a successful pull does not clear a halted push failure");
  sync.setPat(null);
  assert.equal(sync.health.state, "mirror");
  assert.equal(sync.health.hasPat, false);
  sync.setOff(true);
  assert.equal(sync.health.state, "local");
  sync.setOff(false);
  sync.setRepo("");
  assert.equal(sync.health.state, "off");
  sync.setRepo(REPO);
  sync.setPat(PAT);
  assert.equal(sync.health.state, "err", "the recorded failure is still the last outcome");
  await sync.retry();
  assert.equal(sync.health.state, "on");

  const noRepo = boot({repo: null, pat: null}).sync;
  assert.equal(noRepo.health.state, "off");
  const fallback = createSync({fetch: gh.fetch, storage: makeStorage(), now: clock.now, repo: "meta/repo", timers: clock});
  assert.equal(fallback.health.state, "mirror", "repo fallback from meta.json/hostname is used when none is saved");
  assert.equal(fallback.health.repo, "meta/repo");
});

test("health_restores_err_across_reloads", async () => {
  const storage = makeStorage();
  const gh = makeGitHub({files: {"status.json": {}}});
  const first = boot({storage, gh, pat: "ghp_revoked"});
  first.sync.commit("a", {s: "applied"});
  await first.sync.flushNow();
  assert.equal(first.sync.health.state, "err");
  const saved = storage.json("jobwatch.sync.v1");
  assert.ok(saved.errAt && saved.err && saved.code === 401);
  const second = boot({storage, gh, pat: "ghp_revoked"});
  assert.equal(second.sync.health.state, "err", "boot restores err instead of assuming on");
  assert.equal(second.sync.health.halted, false, "halted is per-tab memory");
  const fixed = boot({storage, gh});
  await fixed.sync.pull();
  assert.equal(fixed.sync.health.state, "on", "a proven read clears a restored error");
});

/* ------------------------------------------------------------------ rescan (§10.15.1) */

const iso = (ms) => new Date(ms).toISOString();
const ROLES = [{id: "r1", active: true, company: "TikTok"}, {id: "r2", active: true, company: "Cerebras"}, {id: "r3", active: false}];

test("rescan_polls_runs_then_contents_api", async () => {
  const gh = makeGitHub({files: {"roles.json": ROLES, "meta.json": {last_run: 1}}});
  const {sync, clock} = boot({gh});
  const it = sync.rescan({dispatch: true});
  const started = await step(it, clock, 0);
  assert.equal(started.type, "started");
  assert.equal(gh.dispatches, 1);
  assert.deepEqual(gh.calls.find((c) => c.method === "POST").body, {ref: "main"}, "ref from GET /repos when meta.branch is unknown");
  assert.equal((await step(it, clock, 0)).type, "waiting");
  gh.runs = [{id: 7, status: "queued", conclusion: null, created_at: iso(clock.now() - 5000), html_url: "https://gh/run/7"}];
  assert.equal((await step(it, clock)).type, "queued");
  gh.runs[0].status = "in_progress";
  assert.equal((await step(it, clock)).type, "running");
  gh.runs[0].status = "completed";
  gh.runs[0].conclusion = "success";
  gh.set("roles.json", [...ROLES, {id: "r4", active: true, company: "Anduril"}, {id: "r5", active: false}]);
  gh.set("meta.json", {last_run: 2});
  const done = await step(it, clock);
  assert.equal(done.type, "done");
  assert.deepEqual(done.added.map((r) => r.id), ["r4"], "compared content, not just 'refreshed'");
  assert.deepEqual(done.meta, {last_run: 2});
  assert.equal(done.roles.length, 5);
  assert.equal((await it.next()).done, true);
  assert.equal(gh.count((c) => c.url.includes("?ts=")), 0, "never the CDN");
});

test("rescan_ignores_old_runs_and_reports_failure", async () => {
  const gh = makeGitHub({files: {"roles.json": ROLES}});
  const {sync, clock} = boot({gh, branch: "main"});
  gh.runs = [{id: 1, status: "completed", conclusion: "success", created_at: iso(clock.now() - 120000)}];
  const it = sync.rescan({dispatch: false, knownIds: ["r1", "r2"]});
  assert.equal((await step(it, clock, 0)).type, "started");
  assert.equal(gh.dispatches, 0);
  assert.equal((await step(it, clock, 0)).type, "waiting", "a run from two minutes ago is not ours");
  gh.runs.unshift({id: 2, status: "completed", conclusion: "failure", created_at: iso(clock.now()), html_url: "https://gh/run/2"});
  const failed = await step(it, clock);
  assert.equal(failed.type, "failed");
  assert.equal(failed.url, "https://gh/run/2");
});

test("rescan_cancelled_run_superseded", async () => {
  const gh = makeGitHub({files: {"roles.json": ROLES, "meta.json": {}}});
  const {sync, clock} = boot({gh, branch: "main"});
  const it = sync.rescan({dispatch: true});
  assert.equal((await step(it, clock, 0)).type, "started");
  gh.runs = [{id: 10, status: "queued", conclusion: null, created_at: iso(clock.now())}];
  assert.equal((await step(it, clock, 0)).type, "queued");
  gh.runs[0] = {...gh.runs[0], status: "completed", conclusion: "cancelled"};
  assert.equal((await step(it, clock)).type, "superseded");
  assert.equal((await step(it, clock)).type, "waiting", "the cancelled run is not picked again");
  gh.runs.unshift({id: 11, status: "in_progress", conclusion: null, created_at: iso(clock.now())});
  assert.equal((await step(it, clock)).type, "running");
  gh.runs[0] = {...gh.runs[0], status: "completed", conclusion: "success"};
  const done = await step(it, clock);
  assert.equal(done.type, "done");
  assert.deepEqual(done.added, []);
});

test("rescan_queued_long_and_timeout", async () => {
  const gh = makeGitHub({files: {"roles.json": ROLES}});
  const {sync, clock} = boot({gh, branch: "main"});
  const it = sync.rescan({knownIds: []});
  await step(it, clock, 0);
  gh.runs = [{id: 3, status: "queued", conclusion: null, created_at: iso(clock.now())}];
  const types = [];
  for (let i = 0; i < 35; i++) {
    const ev = await step(it, clock);
    types.push(ev.type);
    if (ev.type === "timeout") break;
  }
  assert.equal(types[0], "queued");
  assert.ok(types.includes("queued-long"), "after 60 s in queue the copy changes");
  assert.equal(types.at(-1), "timeout");
  assert.equal((await it.next()).done, true);
});

test("rescan_fallback_sha_poll_on_403", async () => {
  const gh = makeGitHub({files: {"roles.json": ROLES}});
  const {sync, clock} = boot({gh, branch: "main"});
  gh.once((r) => r.path.endsWith("/runs"), () => res(403, {message: "Resource not accessible"}));
  const it = sync.rescan({knownIds: ["r1", "r2"]});
  assert.equal((await step(it, clock, 0)).type, "started");
  assert.equal((await step(it, clock, 0)).type, "fallback");
  assert.equal((await step(it, clock)).type, "waiting");
  gh.set("roles.json", [...ROLES, {id: "r9", active: true}]);
  const done = await step(it, clock);
  assert.equal(done.type, "done");
  assert.equal(done.viaSha, true);
  assert.deepEqual(done.added.map((r) => r.id), ["r9"]);
  assert.equal(gh.count((c) => c.path.endsWith("/runs")), 1, "no more Actions calls after a 403");

  const gh2 = makeGitHub({files: {"roles.json": ROLES}});
  const second = boot({gh: gh2, branch: "main"});
  gh2.once((r) => r.path.endsWith("/runs"), () => res(403, {}));
  const it2 = second.sync.rescan({knownIds: []});
  await step(it2, second.clock, 0);
  await step(it2, second.clock, 0);
  let last;
  for (let i = 0; i < 30; i++) {
    last = await step(it2, second.clock);
    if (last.type === "timeout") break;
  }
  assert.equal(last.type, "timeout");
  assert.match(last.message, /4 min/);
});

test("rescan_requires_token", async () => {
  const {sync} = boot({pat: null});
  await assert.rejects(sync.rescan().next(), (e) => e.name === "UIError");
});

/* ------------------------------------------------------------------ storage contract (§5.8) */

test("persisted_keys_are_exactly_spec_5_8", async () => {
  const storage = makeStorage({"jobwatch.marks.v2": {a: "applied"}});
  const gh = makeGitHub({files: {"status.json": {}}});
  const {sync, banner} = boot({storage, gh});
  await sync.pull();
  banner("local-orphans")[0].discard();
  sync.commit("b", {s: "seen"});
  await sync.flushNow();
  sync.setOff(true);
  for (const key of storage.keys()) assert.ok(KEYS.includes(key), `unexpected key ${key}`);
  assert.deepEqual(storage.json("jobwatch.migrated.v3"), {at: T0, check: false});
  assert.equal(storage.get("jobwatch.sync.off"), "1");
  assert.equal(storage.get("jobwatch.gh.repo"), REPO);
  assert.equal(storage.get("jobwatch.gh.pat"), PAT);
  assert.ok(Array.isArray(storage.json("jobwatch.trash.v1")));
  assert.deepEqual(Object.keys(storage.json("jobwatch.sync.v1")).sort(), ["code", "err", "errAt", "okAt", "pushedAt"]);
});

test("corrupt_marks_are_stashed_not_lost", () => {
  const storage = makeStorage({"jobwatch.migrated.v3": {at: 1, check: false}});
  storage.set("jobwatch.marks.v3", "{oops");
  const {sync, banner, storage: s} = boot({storage});
  assert.deepEqual(sync.marks, {});
  const stash = s.keys().find((k) => k.startsWith("jobwatch.marks.corrupt."));
  assert.ok(stash);
  assert.equal(s.get(stash), "{oops");
  assert.equal(s.get("jobwatch.marks.v3"), "{}");
  assert.equal(banner("marks-corrupt").length, 1);
});

test("boot_issues_zero_fetches_and_migrates_once", () => {
  const storage = makeStorage({"jobwatch.marks.v2": {a: "applied", b: "bogus"}});
  const {sync, gh} = boot({storage});
  assert.equal(gh.calls.length, 0);
  assert.deepEqual(sync.marks, {a: {s: "applied"}});
  assert.deepEqual(storage.json("jobwatch.marks.v3"), {a: {s: "applied"}});
  assert.equal(storage.json("jobwatch.migrated.v3").check, true);
  const fresh = boot({storage: makeStorage()});
  assert.equal(fresh.storage.json("jobwatch.migrated.v3").check, false, "nothing to check on a fresh device");
});

test("setOff_suppresses_pull_and_push", async () => {
  const {sync, gh, clock} = boot({gh: makeGitHub({files: {"status.json": {r: {s: "seen", t: 1}}}})});
  sync.setOff(true);
  sync.commit("a", {s: "applied"});
  await sync.pull();
  await clock.advance(5000);
  assert.equal(gh.calls.length, 0);
  assert.deepEqual(Object.keys(sync.marks), ["a"]);
  sync.setOff(false);
  await sync.pull();
  assert.deepEqual(Object.keys(sync.marks).sort(), ["a", "r"]);
});
