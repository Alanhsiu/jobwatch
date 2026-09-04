// node --test 'tests/js/*.test.mjs' — mergeMarks, one test per row of the §10.4.2 table plus the properties it must keep.
import {test} from "node:test";
import assert from "node:assert/strict";
import {mergeMarks, parseMarks, valueOf} from "../../assets/lib.js";

const T = 1_788_500_000;
const none = new Set();
const dirty = (...ids) => new Set(ids);

function merge(local, remote, d = none, auth = true) {
  return mergeMarks(local, remote, d, auth);
}

/* ------------------------------------------------------------------ the table */

test("case1_local_absent_takes_remote", () => {
  const {merged, changedIds, dropped} = merge({}, {a: {s: "applied", t: T}, b: {d: T}});
  assert.deepEqual(merged, {a: {s: "applied", t: T}, b: {d: T}});
  assert.deepEqual([...changedIds].sort(), ["a", "b"]);
  assert.deepEqual(dropped, []);
});

test("case2_dirty_local_kept_when_remote_absent", () => {
  const L = {a: {s: "seen", t: T}};
  const {merged, dropped, changedIds} = merge(L, {}, dirty("a"), true);
  assert.deepEqual(merged, L);
  assert.deepEqual(dropped, []);
  assert.equal(changedIds.size, 0);
});

test("case3_clean_local_dropped_when_authoritative_remote_lacks_it", () => {
  const {merged, dropped, changedIds} = merge({a: {s: "seen", t: T}, b: {s: "applied"}}, {}, none, true);
  assert.deepEqual(merged, {});
  assert.deepEqual(dropped.map((d) => [d.id, d.why]).sort(), [["a", "remote-deleted"], ["b", "remote-deleted"]]);
  assert.deepEqual([...changedIds].sort(), ["a", "b"]);
});

test("case4_clean_local_kept_when_remote_not_authoritative", () => {
  const L = {a: {s: "seen", t: T}};
  const {merged, dropped, changedIds} = merge(L, {}, none, false);
  assert.deepEqual(merged, L);
  assert.deepEqual(dropped, []);
  assert.equal(changedIds.size, 0);
});

test("case5_both_timestamped_newer_wins_tie_rules", () => {
  const older = {s: "seen", t: T - 10};
  const newer = {s: "applied", t: T};
  assert.deepEqual(merge({a: older}, {a: newer}).merged.a, newer, "remote newer");
  assert.deepEqual(merge({a: newer}, {a: older}).merged.a, newer, "local newer");
  const tieDiff = {s: "oa", t: T};
  assert.deepEqual(merge({a: newer}, {a: tieDiff}).merged.a, tieDiff, "tie → remote when clean");
  assert.deepEqual(merge({a: newer}, {a: tieDiff}, dirty("a")).merged.a, newer, "tie → local when dirty");
  const r = merge({a: older}, {a: newer});
  assert.deepEqual(r.dropped, [{id: "a", entry: older, why: "lww-loser"}], "loser stashed when values differ");
  const same = merge({a: {s: "applied", t: T - 10}}, {a: {s: "applied", t: T}});
  assert.deepEqual(same.dropped, [], "no trash when only t differs");
  assert.deepEqual(same.merged.a, {s: "applied", t: T});
  assert.equal(merge({a: newer}, {a: older}).changedIds.size, 0, "local winner ⇒ nothing changed locally");
});

test("case6_tless_remote_vs_timestamped_local", () => {
  const L = {s: "applied", t: T, h: [{s: "applied", t: T}]};
  assert.deepEqual(merge({a: L}, {a: {s: "applied"}}).merged.a, L, "equal value keeps local t/h");
  assert.deepEqual(merge({a: L}, {a: {s: "oa"}}, dirty("a")).merged.a, L, "dirty local beats a t-less change");
  const adopted = merge({a: L}, {a: {s: "oa"}}).merged.a;
  assert.deepEqual(adopted, {s: "oa", h: [{s: "applied", t: T}, {s: "oa", t: null}]}, "clean local adopts the old-page edit, history carried forward");
});

test("case7_tless_local_vs_timestamped_remote_takes_remote", () => {
  const R = {s: "oa", t: T};
  const r = merge({a: {s: "applied"}}, {a: R});
  assert.deepEqual(r.merged.a, R);
  assert.deepEqual(r.dropped, [{id: "a", entry: {s: "applied"}, why: "lww-loser"}]);
  assert.deepEqual(merge({a: {s: "applied"}}, {a: R}, dirty("a")).merged.a, R, "even when dirty: a real timestamp beats a legacy entry");
});

test("case8_both_tless", () => {
  assert.deepEqual(merge({a: {s: "applied"}}, {a: {s: "applied"}}).merged.a, {s: "applied"});
  assert.equal(merge({a: {s: "applied"}}, {a: {s: "applied"}}).changedIds.size, 0);
  assert.deepEqual(merge({a: {s: "applied"}}, {a: {s: "oa"}}).merged.a, {s: "oa"}, "differ → remote when clean");
  assert.deepEqual(merge({a: {s: "applied"}}, {a: {s: "oa"}}, dirty("a")).merged.a, {s: "applied"}, "differ → local when dirty");
  const withH = merge({a: {s: "applied", h: [{s: "applied", t: null}]}}, {a: {s: "oa"}}).merged.a;
  assert.deepEqual(withH, {s: "oa", h: [{s: "applied", t: null}, {s: "oa", t: null}]});
});

/* ------------------------------------------------------------------ tombstones */

test("tombstone_beats_older_live", () => {
  const r = merge({a: {s: "applied", t: T - 5, star: true}}, {a: {d: T}});
  assert.deepEqual(r.merged.a, {d: T});
  assert.deepEqual(r.dropped, [{id: "a", entry: {s: "applied", t: T - 5, star: true}, why: "lww-loser"}]);
});

test("live_beats_older_tombstone", () => {
  assert.deepEqual(merge({a: {d: T - 5}}, {a: {s: "applied", t: T}}).merged.a, {s: "applied", t: T});
  assert.deepEqual(merge({a: {s: "applied", t: T}}, {a: {d: T - 5}}).merged.a, {s: "applied", t: T});
  const r = merge({a: {d: T - 5}}, {a: {s: "applied", t: T}});
  assert.deepEqual(r.dropped, [{id: "a", entry: {d: T - 5}, why: "lww-loser"}], "a resurrected deletion is recorded");
});

test("tombstone_vs_tless_remote", () => {
  assert.deepEqual(merge({a: {d: T}}, {a: {s: "applied"}}).merged.a, {s: "applied"}, "old page re-pushed a t-less mark: adopted when clean (case 6)");
  assert.deepEqual(merge({a: {d: T}}, {a: {s: "applied"}}, dirty("a")).merged.a, {d: T}, "a dirty deletion is kept");
});

/* ------------------------------------------------------------------ named guarantees */

test("tless_remote_equal_value_keeps_local_t", () => {
  const L = {s: "applied", star: true, t: T, h: [{s: "applied", t: T}]};
  const r = merge({a: L}, {a: {s: "applied", star: true}});
  assert.deepEqual(r.merged.a, L);
  assert.equal(r.changedIds.size, 0);
});

test("tless_remote_changed_value_wins_when_clean", () => {
  const r = merge({a: {s: "applied", t: T}}, {a: {s: "dropped"}});
  assert.deepEqual(r.merged.a, {s: "dropped"});
  assert.deepEqual(r.dropped[0].why, "lww-loser");
});

test("tless_remote_wins_carries_h_forward", () => {
  const h = Array.from({length: 12}, (_, i) => ({s: i % 2 ? "oa" : "applied", t: T - 100 + i}));
  const r = merge({a: {s: "oa", t: T, h}}, {a: {s: "rejected"}});
  assert.equal(r.merged.a.h.length, 12, "capped at 12");
  assert.deepEqual(r.merged.a.h.at(-1), {s: "rejected", t: null});
  assert.deepEqual(r.merged.a.h[0], h[1], "oldest dropped");
  const sameStage = merge({a: {s: "oa", t: T, h: [{s: "oa", t: T}], star: true}}, {a: {s: "oa"}});
  assert.deepEqual(sameStage.merged.a, {s: "oa", h: [{s: "oa", t: T}]}, "star removed by the old page; no duplicate stage entry appended");
  const starOnlyRemote = merge({a: {s: "oa", t: T, h: [{s: "oa", t: T}]}}, {a: {star: true}});
  assert.deepEqual(starOnlyRemote.merged.a, {star: true, h: [{s: "oa", t: T}]}, "no stage in R ⇒ nothing appended");
});

test("tless_remote_loses_to_dirty", () => {
  const L = {s: "applied", t: T};
  assert.deepEqual(merge({a: L}, {a: {s: "dropped"}}, dirty("a")).merged.a, L);
});

test("remote_404_never_drops", () => {
  const local = {a: {s: "applied"}, b: {s: "seen", t: T}, c: {d: T}};
  const r = merge(local, parseMarks(null), none, false);
  assert.deepEqual(r.merged, local);
  assert.deepEqual(r.dropped, []);
});

test("remote_parse_error_not_authoritative", () => {
  const local = {a: {s: "applied"}};
  const r = merge(local, parseMarks(undefined), none, false);
  assert.deepEqual(r.merged, local);
});

test("mirror_never_authoritative", () => {
  const local = {a: {s: "applied"}, b: {s: "oa", t: T}};
  const mirror = {b: {s: "oa", t: T}, c: {s: "seen", t: T}};
  const r = merge(local, mirror, none, false);
  assert.deepEqual(r.merged, {a: {s: "applied"}, b: {s: "oa", t: T}, c: {s: "seen", t: T}}, "a is kept, c is imported");
  assert.deepEqual(r.dropped, []);
});

test("dropped_go_to_trash", () => {
  const r = merge({a: {s: "applied", t: T - 1}, b: {s: "seen"}, c: {s: "oa", t: T}}, {a: {d: T}, c: {s: "oa", t: T + 1}}, none, true);
  assert.deepEqual(r.dropped.map((d) => [d.id, d.why]), [["a", "lww-loser"], ["b", "remote-deleted"]]);
  for (const d of r.dropped) assert.ok(d.entry && typeof d.entry === "object", "the full losing entry is preserved");
  assert.equal(valueOf(r.dropped[0].entry), '{"s":"applied"}');
});

test("merge_is_idempotent", () => {
  const local = {a: {s: "applied", t: T - 1}, b: {s: "seen"}, c: {s: "oa", t: T}, d: {d: T}, e: {s: "applied", t: T, h: [{s: "applied", t: T}]}};
  const remote = {a: {d: T}, c: {s: "oa", t: T + 1}, e: {s: "oa"}, f: {s: "seen", t: T}};
  const once = merge(local, remote, dirty("b"), true).merged;
  const twice = merge(once, remote, dirty("b"), true);
  assert.deepEqual(twice.merged, once);
  assert.equal(twice.changedIds.size, 0);
  assert.deepEqual(twice.dropped, []);
});

test("merge_commutes_for_timestamped_entries", () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const stages = ["seen", "applied", "oa", "interview", "offer", "rejected", "dropped"];
  let clock = T;
  const entry = () => (rnd() < 0.2 ? {d: ++clock} : {s: pick(stages), t: ++clock, ...(rnd() < 0.3 ? {star: true} : {})});
  for (let i = 0; i < 200; i++) {
    const A = {};
    const B = {};
    for (let k = 0; k < 6; k++) {
      const id = `id${k}`;
      const inA = rnd() < 0.7;
      const inB = rnd() < 0.7;
      if (inA) A[id] = entry();
      if (inB) B[id] = entry();
    }
    const ab = merge(A, B, none, false).merged;
    const ba = merge(B, A, none, false).merged;
    assert.deepEqual(ab, ba, `case ${i}: A=${JSON.stringify(A)} B=${JSON.stringify(B)}`);
  }
});

test("merge_does_not_mutate_inputs", () => {
  const local = {a: {s: "applied", t: T, h: [{s: "applied", t: T}]}};
  const remote = {a: {s: "oa"}};
  const before = JSON.stringify([local, remote]);
  merge(local, remote, none, true);
  assert.equal(JSON.stringify([local, remote]), before);
});
