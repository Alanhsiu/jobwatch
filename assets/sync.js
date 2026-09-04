/**
 * jobwatch tracker — sync engine (DOM-free; every dependency is injected so `node --test` runs it against fakes).
 *
 * Owns the marks model (§10.4.1), the single mutation path `commit()` (§10.4.3), cross-tab reconciliation
 * (`absorbDisk`), pull/push against the GitHub Contents API (§10.4.4–5), delta read-modify-write of the list
 * files (§10.4.6), the health model (§10.4.7), token verification (§10.15) and rescan polling (§10.15.1).
 * Persisted localStorage keys are exactly those of §5.8 and are written through the injected `storage`.
 *
 * Storage contract: `storage.get(key) → string|null`, `storage.set(key, string)`, `storage.del(key)` — the
 * app wraps localStorage in try/catch with an in-memory fallback; the engine does the JSON encoding so it can
 * stash a corrupt `marks.v3` verbatim before starting from `{}`.
 */
import {parseMarks, serializeMarks, mergeMarks, entryTime, isMark, valueOf, norm, validateConfig, humanizeError} from "./lib.js?v=2";

/** Whole-entry identity (s/star/note AND t/h): what a PUT acknowledged, so an edit that toggles back to the same
 *  stage during the PUT still differs (newer t, longer h) and stays dirty until the next PUT carries it. */
const entryJson = (e) => JSON.stringify(e ?? null);

const API = "https://api.github.com";
const WORKFLOW = "jobwatch.yml";
const KEYS = Object.freeze({
  marks: "jobwatch.marks.v3",
  marksV2: "jobwatch.marks.v2",
  dirty: "jobwatch.dirty.v1",
  migrated: "jobwatch.migrated.v3",
  trash: "jobwatch.trash.v1",
  repo: "jobwatch.gh.repo",
  pat: "jobwatch.gh.pat",
  off: "jobwatch.sync.off",
  health: "jobwatch.sync.v1",
});
const COMMIT_MESSAGES = {
  "status.json": "jobwatch: update tracker state",
  "companies.json": "jobwatch: update tracked companies",
  "manual.json": "jobwatch: update manual roles",
  "config.json": "jobwatch: update config",
};
const DEBOUNCE_MS = 2000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_ATTEMPTS = BACKOFF_MS.length;
const EXHAUSTED_RETRY_MS = 60000;
const TRASH_CAP = 100;
const RESCAN_POLL_MS = 10000;
const RESCAN_CAP_MS = 5 * 60000;
const RESCAN_SHA_CAP_MS = 4 * 60000;
const RESCAN_QUEUED_WARN_MS = 60000;
const RESCAN_SLACK_MS = 30000;
const STALE_SHA = "0".repeat(40);

/** Error meant for the user verbatim (`e.name === "UIError"`); anything else is a transport/GitHub error. */
class UIError extends Error {
  constructor(message) {
    super(message);
    this.name = "UIError";
  }
}

/** Transport error: `status` (0 for network failures), `kind` http|network|parse, response `headers`, `file`. */
class GhError extends Error {
  constructor(message, {status = 0, kind = "http", headers = null, file = null} = {}) {
    super(message);
    this.name = "GhError";
    this.status = status;
    this.kind = kind;
    this.headers = headers;
    this.file = file;
  }
}

/**
 * Build the sync engine. Nothing touches the network at construction; the app calls `pull()` and, when
 * `dirty.size > 0`, `schedulePush()` after first paint (§10.2 steps 4–5).
 *
 * @param {object} deps
 * @param {typeof fetch} deps.fetch
 * @param {{get(k: string): string|null, set(k: string, v: string): void, del(k: string): void}} deps.storage
 * @param {() => number} [deps.now] epoch milliseconds
 * @param {() => boolean} [deps.online]
 * @param {string|null} [deps.repo] fallback `owner/repo` when none is saved (e.g. from meta.json or the hostname)
 * @param {string|null} [deps.pat] fallback token when none is saved
 * @param {string|null|(() => string|null)} [deps.branch] branch for reads/writes/dispatch; null = repo default
 * @param {(ids: string[]) => void} [deps.onMarks] marks changed by pull/absorb/commit — patch these rows
 * @param {(health: object) => void} [deps.onHealth] called with the live `health` object on every change
 * @param {(id: string, payload: object|string|null) => void} [deps.onBanner] §10.13 ids; null clears
 * @param {(level: string, message: string, data?: unknown) => void} [deps.onLog]
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers] injectable clock for tests
 * @returns {object} see §10.3 (plus `absorbDisk()` for the app's `storage` event handler)
 */
export function createSync({
  fetch, storage, now = Date.now, online = () => true, repo = null, pat = null, branch = null,
  onMarks = () => {}, onHealth = () => {}, onBanner = () => {}, onLog = () => {}, timers = globalThis,
} = {}) {
  const nowS = () => Math.floor(now() / 1000);
  const store = jsonStore(storage);
  const branchOf = typeof branch === "function" ? branch : () => branch || null;

  let currentRepo = cleanRepo(store.getString(KEYS.repo) || repo);
  let currentPat = store.getString(KEYS.pat) || pat || null;
  let off = store.getString(KEYS.off) === "1";

  const marks = {};
  const dirty = new Set();
  const removed = new Map();
  const acked = new Map();
  const written = new Map();           // id → canonical JSON this tab last wrote to marks.v3 (own writes are not another tab's edit)
  const loaded = new Set();
  const trash = loadTrash();
  let migrated;
  let pendingOrphans = [];
  let halted = false;
  let pushing = false;
  let pushAgain = false;
  let pulling = false;
  let putEpoch = 0;                    // bumped by every PUT ack; a pull whose GET predates an ack is stale
  let pushTimer = null;
  let inflight = 0;
  let lastErr = null;
  let pendingReason = null;
  let errBannerShown = false;
  let offlineBannerShown = false;
  let retryBannerShown = false;

  const health = {state: "off", okAt: null, pushedAt: null, errAt: null, err: null, code: null, pending: 0, halted: false, reason: null, repo: null, hasPat: false};
  const gh = ghClient(() => currentRepo, () => currentPat);

  bootMarks();
  bootHealth();
  emitHealth();

  /* ------------------------------------------------------------------ boot */

  function bootMarks() {
    Object.assign(marks, readDiskMarks(true));
    const flag = store.getJson(KEYS.migrated, null);
    if (isPlainObject(flag)) {
      migrated = {at: flag.at ?? now(), check: flag.check === true};
      rememberWritten(serializeMarks(marks, nowS()));   // the disk as this tab has taken it in
    } else {
      let imported = 0;
      const legacy = storage.get(KEYS.marksV2);
      if (legacy != null) {
        for (const [id, entry] of Object.entries(parseMarks(safeParse(legacy)))) {
          if (!(id in marks)) {
            marks[id] = entry;
            imported++;
          }
        }
      }
      migrated = {at: now(), check: imported > 0};
      store.setJson(KEYS.migrated, migrated);
      writeMarks();
      if (imported) onLog("info", `migrated ${imported} marks from marks.v2`);
    }
    const savedDirty = store.getJson(KEYS.dirty, []);
    if (!Array.isArray(savedDirty)) onLog("warn", "dirty.v1 was not a list — ignoring it (rewritten on the next change)");
    for (const id of asStringList(savedDirty)) if (id in marks) dirty.add(id);
  }

  function readDiskMarks(stashCorrupt) {
    const raw = storage.get(KEYS.marks);
    if (raw == null || raw === "") return {};
    try {
      return parseMarks(JSON.parse(raw));
    } catch {
      if (stashCorrupt) {
        const key = `jobwatch.marks.corrupt.${now()}`;
        storage.set(key, raw);
        storage.set(KEYS.marks, "{}");
        onLog("warn", `marks.v3 was not valid JSON — stashed as ${key}, starting from {}`);
        onBanner("marks-corrupt", {key});
      }
      return {};
    }
  }

  function loadTrash() {
    const saved = store.getJson(KEYS.trash, []);
    return Array.isArray(saved) ? saved : [];
  }

  function bootHealth() {
    const saved = store.getJson(KEYS.health, null);
    if (!isPlainObject(saved)) return;
    health.okAt = saved.okAt ?? null;
    health.pushedAt = saved.pushedAt ?? null;
    health.errAt = saved.errAt ?? null;
    health.err = saved.err ?? null;
    health.code = saved.code ?? null;
    if (health.errAt && health.errAt > (health.okAt || 0)) lastErr = {source: "boot"};
  }

  /* ------------------------------------------------------------------ health (§10.4.7) */

  function deriveState() {
    if (!currentRepo) return "off";
    if (off) return "local";
    if (!currentPat) return "mirror";
    if (inflight > 0) return "busy";
    if (lastErr) return "err";
    if (pendingReason && dirty.size) return "pending";
    return "on";
  }

  function emitHealth() {
    health.pending = dirty.size;
    health.halted = halted;
    health.reason = pendingReason;
    health.repo = currentRepo;
    health.hasPat = !!currentPat;
    health.state = deriveState();
    onHealth(health);
  }

  function recordOk({push}) {
    health.okAt = now();
    health.err = null;
    health.code = null;
    if (push) {
      health.pushedAt = health.okAt;
      lastErr = null;
      pendingReason = null;
    } else if (!halted) {
      lastErr = null;               // a halted push failure survives a successful pull (§10.4.5)
    }
    persistHealth();
  }

  function recordErr(e, source) {
    health.errAt = now();
    health.err = humanizeError(e, {pat: true, repo: currentRepo});
    health.code = e?.status ?? null;
    lastErr = {source};
    persistHealth();
    onLog("error", `${source} failed: ${health.err}`, e);
  }

  function persistHealth() {
    store.setJson(KEYS.health, {okAt: health.okAt, pushedAt: health.pushedAt, errAt: health.errAt, err: health.err, code: health.code});
  }

  function showErrBanner() {
    errBannerShown = true;
    onBanner("sync-err", health.err);
  }

  function clearErrBanner() {
    if (!errBannerShown) return;
    errBannerShown = false;
    onBanner("sync-err", null);
  }

  function showRetryBanner() {
    retryBannerShown = true;
    onBanner("pending-retry", {n: dirty.size});
    onLog("warn", "push: GitHub not answering — retrying in 60 s");
  }

  function clearRetryBanner() {
    if (!retryBannerShown) return;
    retryBannerShown = false;
    onBanner("pending-retry", null);
  }

  /* ------------------------------------------------------------------ mutation + persistence (§10.4.3) */

  /**
   * The only mutation path. `next === null` writes a tombstone; otherwise `{s, star, note}` of `next` are kept,
   * `t` is stamped fresh and `h` is appended when the stage changes (a legacy entry seeds `{s, t: null}`).
   * `restore` (undo) keeps `s/star/note/h` verbatim with a fresh `t`. Re-committing the same value is a no-op.
   * @returns {object|null} deep copy of the previous entry (for undo)
   */
  function commit(id, next, {silent = false, restore = false} = {}) {
    const prev = marks[id] ? structuredClone(marks[id]) : null;
    const now = nowS();
    const t = entryTime(prev) > now ? entryTime(prev) + 1 : now;   // a change made on top of an entry stamped in our future (clock skew) must still order after it
    let entry;
    if (next === null || !isMark(next)) {
      entry = {d: t};
    } else if (restore) {
      entry = {...pickMark(next), t};
      if (Array.isArray(next.h) && next.h.length) entry.h = next.h.slice(-12);
    } else {
      entry = {...pickMark(next), t};
      if (entry.s && prev?.s !== entry.s) {
        const h = [...(prev?.h || [])];
        if (prev?.s && !prev.t && !h.length) h.push({s: prev.s, t: null});
        h.push({s: entry.s, t});
        entry.h = h.slice(-12);
      } else if (prev?.h) {
        entry.h = prev.h;
      }
    }
    if (prev && valueOf(prev) === valueOf(entry) && !restore) return prev;
    marks[id] = entry;
    dirty.add(id);
    removed.delete(id);
    acked.delete(id);
    if (pendingOrphans.length) pendingOrphans = pendingOrphans.filter((x) => x !== id);   // an explicit edit answers the orphans banner for this id: keep
    persistAll();
    emitHealth();
    if (!silent) onMarks([id]);
    schedulePush();
    return prev;
  }

  /**
   * Cross-tab primitive: take in newer entries another tab wrote. Entries still equal to this tab's own last write
   * are not edits at all (the disk usually IS our previous write — comparing against it would undo every merge
   * verdict whose t is lower than what we wrote before), and a stale copy of an id this tab dropped never comes back.
   */
  function absorbDisk() {
    refreshMigration();
    const disk = readDiskMarks(false);
    const diskCanon = serializeMarks(disk, nowS());
    const diskDirty = new Set(asStringList(store.getJson(KEYS.dirty, [])));
    const changed = [];
    for (const [id, R] of Object.entries(disk)) {
      if (id in diskCanon && written.get(id) === JSON.stringify(diskCanon[id])) continue;   // unchanged since this tab wrote it
      if (removed.has(id) && entryTime(R) < removed.get(id)) continue;                        // case 3 / Discard / LWW loser; a real re-mark (t ≥ removal time) still lands
      const L = marks[id];
      if (!L || entryTime(R) > entryTime(L) || (entryTime(R) === entryTime(L) && !dirty.has(id) && valueOf(R) !== valueOf(L))) {
        marks[id] = R;
        changed.push(id);
      }
    }
    for (const id of diskDirty) if (id in marks && acked.get(id) !== entryJson(marks[id])) dirty.add(id);
    return changed;
  }

  /** Memory is authoritative for this tab: absorb first, then write memory VERBATIM (never disk ∪ memory). */
  function persistAll() {
    absorbDisk();
    writeMarks();
    store.setJson(KEYS.dirty, [...dirty]);
  }

  function writeMarks() {
    const out = serializeMarks(marks, nowS());
    store.setJson(KEYS.marks, out);
    rememberWritten(out);
  }

  function rememberWritten(canon) {
    written.clear();
    for (const [id, e] of Object.entries(canon)) written.set(id, JSON.stringify(e));
  }

  /** For the app's `storage` event handler (another tab wrote marks.v3 / dirty.v1). */
  function absorbDiskPublic() {
    const before = dirty.size;
    const changed = absorbDisk();
    if (changed.length) onMarks(changed);
    if (dirty.size !== before) {
      emitHealth();
      schedulePush();
    }
    return changed;
  }

  function adopt(merged, dropped) {
    replaceContents(marks, merged);
    for (const d of dropped) {
      removed.set(d.id, nowS());
      stash(d);
    }
    persistAll();
  }

  function stash(item) {
    const last = trash.findLast((x) => x.id === item.id);
    if (last && valueOf(last.entry) === valueOf(item.entry)) return;
    trash.push({id: item.id, entry: item.entry, why: item.why, at: now()});
    if (trash.length > TRASH_CAP) trash.splice(0, trash.length - TRASH_CAP);
    store.setJson(KEYS.trash, trash);
  }

  /* ------------------------------------------------------------------ pull (§10.4.4) */

  /**
   * Fetch status.json (Contents API with a token, same-origin mirror without), merge, persist, notify.
   * The one-time orphans banner fires here when legacy local marks are absent from an authoritative remote.
   */
  async function pull(reason = "") {
    if (off || pulling) return;
    pulling = true;
    const withPat = usePat();
    if (withPat) {
      inflight++;
      emitHealth();
    }
    try {
      const epoch = putEpoch;
      const src = withPat ? await gh.getJson("status.json") : await pagesGetJson("status.json");
      if (putEpoch !== epoch) {                       // a PUT landed while this GET was in flight: its answer predates the repo's current state
        onLog("info", `pull skipped (${reason || "manual"}): superseded by a push`);
        return;
      }
      refreshMigration();
      const auth = withPat && src.status === 200 && isPlainObject(src.json);
      const remote = parseMarks(src.json || {});
      let {merged, changedIds, dropped} = mergeMarks(marks, remote, dirty, auth);
      let orphans = [];
      if (auth && migrated.check) {
        orphans = dropped.filter((d) => d.why === "remote-deleted").map((d) => d.id);
        for (const id of orphans) {
          merged[id] = marks[id];
          changedIds.delete(id);
        }
        dropped = dropped.filter((d) => d.why !== "remote-deleted");
        if (!orphans.length) finishMigration();
      }
      adopt(merged, dropped);
      if (withPat) {
        recordOk({push: false});
        if (!lastErr) clearErrBanner();
      }
      if (orphans.length) {
        pendingOrphans = orphans;
        onBanner("local-orphans", {n: orphans.length, ids: orphans, push: keepOrphans, discard: discardOrphans});
      }
      if (changedIds.size) onMarks([...changedIds]);
      if (withPat && dirty.size) schedulePush(500);
      if (!currentPat && currentRepo && Object.keys(remote).length) onBanner("mirror", {n: Object.keys(remote).length});
      onLog("info", `pull ok (${reason || "manual"}): ${Object.keys(remote).length} remote, ${changedIds.size} changed`);
    } catch (e) {
      if (withPat) {
        recordErr(e, "pull");
        showErrBanner();
      } else {
        onLog("warn", `status.json mirror read failed: ${humanizeError(e, {pat: false})}`);
      }
    } finally {
      pulling = false;
      if (withPat) inflight--;
      emitHealth();
    }
  }

  /** [Push them] — for the ids still awaiting an answer (an id edited while the banner was up was answered by that edit). */
  function keepOrphans() {
    for (const id of pendingOrphans) if (id in marks) dirty.add(id);
    finishMigration();
    persistAll();
    emitHealth();
    schedulePush();
  }

  function discardOrphans() {
    const ids = pendingOrphans.filter((id) => id in marks);
    for (const id of ids) {
      stash({id, entry: marks[id], why: "discarded"});
      delete marks[id];
      removed.set(id, nowS());
      dirty.delete(id);
      acked.delete(id);
    }
    finishMigration();
    persistAll();
    emitHealth();
    onMarks(ids);
  }

  function finishMigration() {
    migrated.check = false;
    pendingOrphans = [];
    store.setJson(KEYS.migrated, migrated);
  }

  /** The orphan check is per device, not per tab: adopt another tab's answer (persisted flag) before deciding anything. */
  function refreshMigration() {
    if (!migrated.check) return;
    const flag = store.getJson(KEYS.migrated, null);
    if (!isPlainObject(flag) || flag.check !== false) return;
    const bannerShown = pendingOrphans.length > 0;
    finishMigration();
    if (bannerShown) onBanner("local-orphans", null);
  }

  /** While the orphans banner is unanswered its ids stay on this device only: neither trashed nor published. */
  function withoutPendingOrphans(all) {
    if (!migrated.check || !pendingOrphans.length) return all;
    const out = {...all};
    for (const id of pendingOrphans) if (!dirty.has(id)) delete out[id];
    return out;
  }

  /* ------------------------------------------------------------------ push (§10.4.5) */

  async function push({manual = false} = {}) {
    if (!usePat() || off) return;
    if (pushing) {
      pushAgain = true;
      return;
    }
    if (!dirty.size) return;
    if (halted && !manual) return;
    if (!online()) {
      halted = true;
      pendingReason = "offline";
      offlineBannerShown = true;
      emitHealth();
      clearRetryBanner();
      onBanner("pending-offline", {n: dirty.size});
      return;
    }
    if (offlineBannerShown) {
      offlineBannerShown = false;
      onBanner("pending-offline", null);
    }
    pushing = true;
    inflight++;
    emitHealth();
    let attempt = 0;
    let exhausted = false;
    const touched = new Set();
    try {
      for (;;) {
        let src;
        try {
          src = await gh.getJson("status.json");
        } catch (e) {
          if (!transient(e)) throw e;
          if (attempt >= MAX_ATTEMPTS) {
            exhausted = true;
            break;
          }
          await sleep(BACKOFF_MS[attempt++]);
          continue;
        }
        refreshMigration();
        const auth = src.status === 200 && isPlainObject(src.json);
        // Until the first pull() has run the one-time orphan check, the remote is not authoritative for drops.
        const {merged, changedIds, dropped} = mergeMarks(marks, parseMarks(src.json || {}), dirty, auth && !migrated.check);
        adopt(merged, dropped);
        for (const id of changedIds) touched.add(id);
        const snap = new Map([...dirty].map((id) => [id, entryJson(marks[id])]));
        const body = serializeMarks(withoutPendingOrphans(marks), nowS());
        if (auth && JSON.stringify(body) === JSON.stringify(serializeMarks(parseMarks(src.json), nowS()))) {
          ack(snap);
          break;
        }
        try {
          await gh.putJson("status.json", body, src.status === 404 ? null : src.sha, COMMIT_MESSAGES["status.json"]);
          ack(snap);
          break;
        } catch (e) {
          if ((e.status === 409 || e.status === 422 || transient(e)) && attempt < MAX_ATTEMPTS) {
            await sleep(BACKOFF_MS[attempt++]);
            continue;
          }
          if (transient(e)) {
            exhausted = true;
            break;
          }
          throw e;
        }
      }
    } catch (e) {
      halted = true;
      recordErr(e, "push");
      showErrBanner();
    } finally {
      pushing = false;
      inflight--;
      if (exhausted) pendingReason = "exhausted";
      emitHealth();
      if (exhausted) showRetryBanner();
      else clearRetryBanner();
      if (touched.size) onMarks([...touched]);
      if (pushAgain) {
        pushAgain = false;
        schedulePush(DEBOUNCE_MS);
      } else if (dirty.size && !halted) {
        schedulePush(exhausted ? EXHAUSTED_RETRY_MS : DEBOUNCE_MS);
      }
    }
  }

  /** Acknowledge the ids whose entry is unchanged since the snapshot; a click during the PUT stays dirty. */
  function ack(snap) {
    for (const [id, v] of snap) {
      if (entryJson(marks[id]) === v) {
        dirty.delete(id);
        acked.set(id, v);
      }
    }
    putEpoch++;
    persistAll();
    recordOk({push: true});
    clearErrBanner();
  }

  function schedulePush(delayMs = DEBOUNCE_MS) {
    if (!usePat() || off) return;
    timers.clearTimeout(pushTimer);
    pushTimer = timers.setTimeout(() => {
      pushTimer = null;
      push();
    }, delayMs);
  }

  function flushNow() {
    timers.clearTimeout(pushTimer);
    pushTimer = null;
    return push();
  }

  /** The banner's [Retry]: lift the halt, then push what is dirty or re-pull to re-check the link. */
  function retry() {
    halted = false;
    emitHealth();
    return dirty.size ? flushNow() : pull("retry");
  }

  /* ------------------------------------------------------------------ files (§10.4.6) */

  /**
   * Read a repo file: Contents API with a token (fresh, with `sha`), same-origin `?ts` fetch without.
   * A 200/404 marks the file as loaded, which `saveList` requires.
   * @returns {Promise<{json: unknown, sha: string|null, status: number, exists: boolean}>}
   */
  async function getFile(file) {
    const r = usePat() ? await gh.getJson(file) : await pagesGetJson(file);
    if (r.status === 200 || r.status === 404) loaded.add(file);
    return {json: r.json, sha: r.sha, status: r.status, exists: r.status === 200};
  }

  /**
   * Delta read-modify-write of companies.json / manual.json / config.json: `{add}` or `{remove}` (matched by
   * `key`) applied to the freshly read list, or `{set}` (config.json is validated first). Retries 409/422 twice.
   * Emptying companies.json requires `confirmEmpty()` to resolve true.
   * @returns {Promise<unknown|null>} the saved value, or null when the empty-list confirm was declined
   */
  async function saveList(file, op, key = defaultKey, {confirmEmpty} = {}) {
    if (!usePat()) throw new UIError("Turn on Sync (token) to edit.");
    if (!loaded.has(file)) throw new UIError("This list has not loaded yet — reload the page first.");
    if (op.set !== undefined && file === "config.json") {
      const check = validateConfig(op.set);
      if (!check.ok) throw new UIError(`config.json: ${check.errors.join("; ")}`);
    }
    for (let attempt = 0; ; attempt++) {
      const {json, sha, status} = await gh.getJson(file);
      let next;
      if (op.set !== undefined) {
        next = op.set;
      } else {
        const raw = Array.isArray(json) ? json : [];
        const base = file === "companies.json" ? dedupeSorted(raw) : raw;   // match against what the page shows (norm'd), not the stored spelling
        if ("add" in op) next = base.some((x) => key(x) === key(op.add)) ? base : [...base, op.add];
        else next = base.filter((x) => key(x) !== key(op.remove));
      }
      if (file === "companies.json") {
        next = dedupeSorted(next);
        if (!next.length) {
          if (!confirmEmpty) throw new UIError("Track nothing? Every role becomes 'not tracked' on the next scan — confirm to save an empty list.");
          if (!(await confirmEmpty())) return null;
        }
      }
      try {
        await gh.putJson(file, next, status === 404 ? null : sha, COMMIT_MESSAGES[file] || `jobwatch: update ${file}`);
        return next;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 2) continue;
        throw e;
      }
    }
  }

  /* ------------------------------------------------------------------ verify (§10.15 Sync) */

  /**
   * Prove a token without committing: GET /repos (exists), GET status.json (read), then PUT the bytes just read
   * with a stale sha — GitHub authorises before comparing shas, so 409 proves write and 403 disproves it.
   * Stores nothing; the app calls setRepo/setPat/setOff on success.
   * @returns {Promise<{ok: boolean, write: true|false|null, reason?: string, defaultBranch?: string}>}
   */
  async function verify(repoArg, patArg) {
    const r = cleanRepo(repoArg);
    const p = String(patArg || "").trim();
    if (!r) return {ok: false, write: null, reason: "Enter the repo as owner/repo"};
    if (!p) return {ok: false, write: null, reason: "Enter a token"};
    const client = ghClient(() => r, () => p);
    let info;
    try {
      info = await client.getApi(`/repos/${r}`);
    } catch (e) {
      return {ok: false, write: null, reason: humanizeError(e, {pat: true, repo: r})};
    }
    const defaultBranch = info?.default_branch;
    let src;
    try {
      src = await client.getJson("status.json");
    } catch (e) {
      return {ok: false, write: null, reason: humanizeError(e, {pat: true, repo: r}), defaultBranch};
    }
    if (src.status === 404) {
      return {ok: true, write: null, reason: "status.json is missing in the repo — write access is confirmed on your first change", defaultBranch};
    }
    try {
      await client.putRaw("status.json", src.raw.replace(/\s+/g, ""), STALE_SHA, "jobwatch: verify sync");
      return {ok: true, write: true, defaultBranch};
    } catch (e) {
      if (e.status === 409) return {ok: true, write: true, defaultBranch};
      if (e.status === 403) return {ok: false, write: false, reason: `Token can't write to ${r}: give it Contents: Read and write`, defaultBranch};
      return {ok: true, write: null, reason: humanizeError(e, {pat: true, repo: r}), defaultBranch};
    }
  }

  /* ------------------------------------------------------------------ rescan (§10.15.1) */

  /**
   * Truthful rescan: optionally dispatch the workflow, then follow the run that started after `t0` and report
   * what actually changed (roles.json via the Contents API, never the CDN). Yields progress events
   * `{type: started|waiting|queued|queued-long|running|superseded|fallback|done|failed|timeout|error, ...}`;
   * `done` carries `added` (active roles not in `knownIds`), `roles` and `meta`.
   * @param {{dispatch?: boolean, knownIds?: Iterable<string>|null}} [opts]
   */
  async function* rescan({dispatch = false, knownIds = null} = {}) {
    if (!usePat()) throw new UIError("Turn on Sync (token) first.");
    const t0 = now();
    const known = knownIds ? new Set(knownIds) : activeIds(await gh.getJson("roles.json"));
    if (dispatch) {
      try {
        const ref = branchOf() || (await gh.getApi(`/repos/${currentRepo}`)).default_branch;
        await gh.post(`/repos/${currentRepo}/actions/workflows/${WORKFLOW}/dispatches`, {ref});
      } catch (e) {
        const message = e.status === 403 || e.status === 404
          ? "Couldn't start a scan — the token needs Actions: Read and write (or run it from the repo's Actions tab)"
          : humanizeError(e, {pat: true, repo: currentRepo});
        yield {type: "error", message};
        return;
      }
    }
    yield {type: "started", dispatched: dispatch, t0};
    const minCreated = t0 - RESCAN_SLACK_MS;
    const ignored = new Set();
    let watching = null;
    let queuedSince = null;
    for (let elapsed = 0; elapsed <= RESCAN_CAP_MS; elapsed += RESCAN_POLL_MS) {
      let runs;
      try {
        runs = (await gh.getApi(`/repos/${currentRepo}/actions/workflows/${WORKFLOW}/runs?per_page=5`)).workflow_runs || [];
      } catch (e) {
        if (e.status !== 403) throw e;
        yield* shaPoll(known);
        return;
      }
      const candidates = runs
        .filter((r) => Date.parse(r.created_at) >= minCreated && !ignored.has(r.id))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const run = (watching && candidates.find((r) => r.id === watching)) || candidates[0] || null;
      if (!run) {
        yield {type: "waiting"};
        await sleep(RESCAN_POLL_MS);
        continue;
      }
      watching = run.id;
      if (run.status === "completed") {
        if (run.conclusion === "cancelled") {
          ignored.add(run.id);
          watching = null;
          yield {type: "superseded", run};
        } else if (run.conclusion === "success") {
          const roles = await gh.getJson("roles.json");
          const meta = await gh.getJson("meta.json");
          const list = Array.isArray(roles.json) ? roles.json : [];
          yield {type: "done", run, added: list.filter((r) => r.active && !known.has(r.id)), roles: list, meta: meta.json};
          return;
        } else {
          yield {type: "failed", run, conclusion: run.conclusion, url: run.html_url};
          return;
        }
      } else if (run.status === "queued") {
        queuedSince ??= now();
        yield {type: now() - queuedSince > RESCAN_QUEUED_WARN_MS ? "queued-long" : "queued", run};
      } else {
        yield {type: "running", run};
      }
      await sleep(RESCAN_POLL_MS);
    }
    yield {type: "timeout", message: "The scan is taking longer than 5 minutes — check the Actions tab"};
  }

  /** Fallback when the token lacks Actions: read — watch roles.json's blob sha instead. */
  async function* shaPoll(known) {
    yield {type: "fallback"};
    const sha0 = (await gh.getJson("roles.json")).sha;
    for (let elapsed = 0; elapsed < RESCAN_SHA_CAP_MS; elapsed += RESCAN_POLL_MS) {
      await sleep(RESCAN_POLL_MS);
      const cur = await gh.getJson("roles.json");
      if (cur.sha !== sha0) {
        const list = Array.isArray(cur.json) ? cur.json : [];
        yield {type: "done", added: list.filter((r) => r.active && !known.has(r.id)), roles: list, meta: null, viaSha: true};
        return;
      }
      yield {type: "waiting"};
    }
    yield {type: "timeout", message: "No list change seen in 4 min — the scan may have found nothing new"};
  }

  function activeIds(src) {
    return new Set((Array.isArray(src.json) ? src.json : []).filter((r) => r && r.active).map((r) => r.id));
  }

  /* ------------------------------------------------------------------ settings */

  function setRepo(value) {
    currentRepo = cleanRepo(value);
    if (currentRepo) store.setString(KEYS.repo, currentRepo);
    else storage.del(KEYS.repo);
    emitHealth();
  }

  function setPat(value) {
    currentPat = value ? String(value).trim() || null : null;
    if (currentPat) store.setString(KEYS.pat, currentPat);
    else storage.del(KEYS.pat);
    halted = false;
    if (!currentPat) cancelPush();
    emitHealth();
  }

  function setOff(value) {
    off = !!value;
    if (off) {
      storage.set(KEYS.off, "1");
      cancelPush();
    } else {
      storage.del(KEYS.off);
    }
    emitHealth();
  }

  /** "Clear local marks on this device": empty marks/dirty, keep the migrated flag so v2 is never re-imported. */
  function clearLocal() {
    cancelPush();
    replaceContents(marks, {});
    dirty.clear();
    removed.clear();
    acked.clear();
    pendingOrphans = [];
    migrated.check = false;
    store.setJson(KEYS.migrated, migrated);
    writeMarks();
    store.setJson(KEYS.dirty, []);
    emitHealth();
  }

  /** State of the one-time §10.4.4 orphan check: pending until answered; ids awaiting the banner's answer. */
  function migrationCheck() {
    return {pending: migrated.check, orphans: [...pendingOrphans]};
  }

  /** Drop the scheduled push (and the banner that promised a retry). */
  function cancelPush() {
    timers.clearTimeout(pushTimer);
    pushTimer = null;
    clearRetryBanner();
  }

  function usePat() {
    return !!(currentPat && currentRepo);
  }

  function sleep(ms) {
    return new Promise((resolve) => timers.setTimeout(resolve, ms));
  }

  /* ------------------------------------------------------------------ transport */

  function ghClient(repoOf, patOf) {
    async function request(method, url, body) {
      const headers = {Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"};
      const token = patOf();
      if (token) headers.Authorization = `Bearer ${token}`;
      const init = {method, headers, cache: "no-store"};
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      try {
        return await fetch(url, init);
      } catch (e) {
        throw new GhError(e?.message || "network error", {kind: "network"});
      }
    }
    async function failure(res, file) {
      let text = "";
      try {
        text = await res.text();
      } catch {
        text = "";
      }
      return new GhError(`HTTP ${res.status}${text ? ` ${text.slice(0, 140)}` : ""}`, {status: res.status, headers: headerMap(res.headers), file});
    }
    async function bodyJson(res) {
      try {
        return await res.json();
      } catch (e) {
        throw new GhError(`unreadable response (${e?.message || "not JSON"})`, {status: res.status, kind: "network"});
      }
    }
    const client = {
      async getJson(file) {
        const ref = branchOf();
        const url = `${API}/repos/${repoOf()}/contents/${file}?${ref ? `ref=${encodeURIComponent(ref)}&` : ""}t=${now()}`;
        const res = await request("GET", url);
        if (res.status === 404) return {status: 404, json: null, sha: null, raw: null};
        if (!res.ok) throw await failure(res, file);
        const meta = await bodyJson(res);
        let json;
        try {
          json = JSON.parse(b64decode(meta.content || ""));
        } catch {
          throw new GhError(`${file} is not valid JSON`, {status: 200, kind: "parse", file});
        }
        return {status: 200, json, sha: meta.sha, raw: meta.content};
      },
      async putRaw(file, contentB64, sha, message) {
        const body = {message, content: contentB64};
        if (sha) body.sha = sha;
        const ref = branchOf();
        if (ref) body.branch = ref;
        const res = await request("PUT", `${API}/repos/${repoOf()}/contents/${file}`, body);
        if (!res.ok) throw await failure(res, file);
        return bodyJson(res);
      },
      putJson(file, obj, sha, message) {
        return client.putRaw(file, b64encode(JSON.stringify(obj, null, 1) + "\n"), sha, message);
      },
      async getApi(path) {
        const res = await request("GET", `${API}${path}`);
        if (!res.ok) throw await failure(res);
        return bodyJson(res);
      },
      async post(path, body) {
        const res = await request("POST", `${API}${path}`, body);
        if (!res.ok) throw await failure(res);
        return res.status;
      },
    };
    return client;
  }

  async function pagesGetJson(file) {
    let res;
    try {
      res = await fetch(`${file}?ts=${now()}`, {cache: "no-store"});
    } catch (e) {
      throw new GhError(e?.message || "network error", {kind: "network", file});
    }
    if (res.status === 404) return {status: 404, json: null, sha: null, raw: null};
    if (!res.ok) throw new GhError(`HTTP ${res.status}`, {status: res.status, file});
    try {
      return {status: 200, json: await res.json(), sha: null, raw: null};
    } catch {
      throw new GhError(`${file} is not valid JSON`, {status: 200, kind: "parse", file});
    }
  }

  /** Authenticated GET of any api.github.com path (the scan pill's Actions-runs lookup, §10.13). Throws GhError. */
  function api(path) {
    if (!usePat()) throw new UIError("A token is needed to read the GitHub API.");
    return gh.getApi(path);
  }

  return {
    marks, dirty, health,
    commit, pull, schedulePush, flushNow, retry, absorbDisk: absorbDiskPublic,
    getFile, saveList, verify, rescan, api,
    setRepo, setPat, setOff, clearLocal, migrationCheck,
  };
}

/* ------------------------------------------------------------------ module helpers */

function transient(e) {
  return e?.kind === "network" || e?.status >= 500 || e?.status === 429;
}

function jsonStore(storage) {
  return {
    getString(key) {
      const v = storage.get(key);
      return typeof v === "string" && v ? v : null;
    },
    setString(key, value) {
      storage.set(key, String(value));
    },
    getJson(key, fallback) {
      const raw = storage.get(key);
      if (raw == null || raw === "") return fallback;
      const parsed = safeParse(raw);
      return parsed === undefined ? fallback : parsed;
    },
    setJson(key, value) {
      storage.set(key, JSON.stringify(value));
    },
  };
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Persisted id lists must not take the page down: anything that is not a list of strings reads as empty. */
function asStringList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

function cleanRepo(value) {
  const r = String(value || "").trim();
  return /^[\w.-]+\/[\w.-]+$/.test(r) ? r : null;
}

function defaultKey(x) {
  return x && typeof x === "object" && "id" in x ? x.id : x;
}

function dedupeSorted(list) {
  return [...new Set(list.map(norm).filter(Boolean))].sort();
}

function pickMark(e) {
  const out = {};
  if (e.s) out.s = e.s;
  if (e.star) out.star = true;
  if (typeof e.note === "string" && e.note.trim()) out.note = e.note.trim();
  return out;
}

function replaceContents(target, source) {
  for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
  Object.assign(target, source);
}

function headerMap(headers) {
  const out = {};
  if (headers && typeof headers.forEach === "function") headers.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
  else if (headers && typeof headers === "object") for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
