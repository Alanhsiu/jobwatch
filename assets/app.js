/**
 * jobwatch tracker — the DOM layer (§10). Boot + version handshake, focus-safe rendering (render/patchRows),
 * groups, notes editor, keyboard, banners, toasts, undo, dialogs and the rescan flow. All state changes to marks go
 * through `sync.commit()`; everything pure lives in lib.js and everything network-facing in sync.js.
 */
import {
  APP_VERSION, STAGES, STAGE_LABEL, DEFAULT_CONFIG, norm, buildView, hashToView, viewToHash, rel, isoDate,
  locationsOf, degreeTag, toCSV, validateConfig, isMark, valueOf, humanizeError,
} from "./lib.js?v=2";
import {createSync} from "./sync.js?v=2";

const VIEW_LABEL = Object.freeze({
  inbox: "Inbox", new: "New", pipeline: "Pipeline", star: "Saved", all: "All", closed: "Closed", untracked: "Untracked",
  seen: "Seen", applied: "Applied", oa: "OA", interview: "Interviewing", offer: "Offer", rejected: "Rejected", dropped: "Dismissed",
});
const SORT_LABEL = Object.freeze({
  company: "By company", newest: "Newest posting", oldest: "Oldest posting", added: "Recently added",
  updated: "Recently updated", closed: "Recently closed",
});
const WHY_LABEL = Object.freeze({
  phd: "PhD-only", title: "title", region: "region", category: "category", sponsorship: "sponsorship", company: "company removed",
});
const QUICK_VIEWS = new Set(["inbox", "new"]);
const PIPELINE = new Set(["applied", "oa", "interview", "offer"]);
const CATS = ["SWE", "ML", "Quant", "HW"];
const KEYS = Object.freeze({ui: "jobwatch.ui.v1", lastVisit: "jobwatch.lastVisit", trash: "jobwatch.trash.v1", repo: "jobwatch.gh.repo"});
const NOTE_IDLE_MS = 2000;
const TOAST_MS = 8000;
const UNDO_DEPTH = 20;
const REFRESH_THROTTLE_MS = 60000;
const SCAN_PILL_MIN_INTERVAL_MS = 5 * 60000;
const NUDGE_S = 21 * 86400;
const STALE_SCAN_S = 26 * 3600;
const FADE_MS = 150;
const HOUR = 3600;

/* ------------------------------------------------------------------ storage shim (§5.8) */

const store = {
  broken: false,
  mem: new Map(),
  get(key) {
    if (this.broken && this.mem.has(key)) return this.mem.get(key);
    try {
      return localStorage.getItem(key);
    } catch {
      this.broken = true;
      return this.mem.get(key) ?? null;
    }
  },
  set(key, value) {
    this.mem.set(key, value);
    try {
      localStorage.setItem(key, value);
    } catch {
      this.broken = true;
    }
  },
  del(key) {
    this.mem.delete(key);
    try {
      localStorage.removeItem(key);
    } catch {
      this.broken = true;
    }
  },
};

function session(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    sessionStorage.setItem(key, value);
  } catch {
    return null;
  }
  return value;
}

/* ------------------------------------------------------------------ state */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const list = $("#list");
const nowS = () => Math.floor(Date.now() / 1000);

let sync;
const state = {
  botRoles: [], manualRoles: [], roles: [], rolesLoaded: false, rolesError: null,
  meta: null, metaKnown: false,
  companies: null, configFile: null, configSha: undefined, lists: {companies: false, manual: false, config: false},
  view: hashToView(""), ui: {theme: "auto", collapsed: [], expanded: []},
  vb: null, cursor: null, expanded: new Set(), collapsed: new Set(), pendingAsk: null,
  undo: [], editor: null, renderQueued: false, lastVisitPrev: null,
  lastRefreshAt: 0, scanPillAt: 0, lastSuccessfulRunMs: null, rescanning: false, pendingG: false,
};
const timers = {toast: null, search: null, chord: null};
let pointerHeld = false;
const deferred = [];

/* ------------------------------------------------------------------ boot (§10.2) */

async function boot() {
  if (await versionMismatchHandled()) return;
  state.ui = readUi();
  applyTheme(state.ui.theme);
  state.collapsed = new Set(state.ui.collapsed);
  state.expanded = new Set(state.ui.expanded);
  state.view = initialView();
  state.lastVisitPrev = Number(store.get(KEYS.lastVisit)) || null;
  sync = createSync({
    fetch: (...args) => fetch(...args), storage: store, now: Date.now, online: () => navigator.onLine,
    repo: hostRepo(), branch: () => state.meta?.branch || null,
    onMarks: (ids) => whenPointerIdle(() => onRemoteMarks(ids)), onHealth: renderHealth, onBanner: onEngineBanner,
    onLog: (level, message) => { if (level === "error") console.error(message); },
  });
  if (store.broken) showBanner("storage", {tone: "warn", text: "This browser blocks or ran out of site storage — marks are kept in memory and in your repo only."});
  wireEvents();
  trackStickyHeight();
  $("#versionLine").textContent = `jobwatch tracker v${APP_VERSION}`;
  await loadRoles();
  const metaThenPull = loadMeta().then(() => sync.pull("boot"));
  await Promise.all([metaThenPull, loadLists()]);
  if (sync.health.hasPat && sync.dirty.size) sync.schedulePush();
  updateScanPill();
  checkConfigStale();
  state.lastRefreshAt = Date.now();          // the first focus/visibility event after boot must not reload everything again
}

async function versionMismatchHandled() {
  const served = Number(document.documentElement.dataset.app);
  if (served === APP_VERSION) return false;
  const guard = `jobwatch.reloaded.${APP_VERSION}`;
  if (!session(guard)) {
    session(guard, "1");
    try {
      await fetch(location.href, {cache: "reload"});
    } catch {
      /* the reload below still helps when the fetch fails */
    }
    location.reload();
    return true;
  }
  showBanner("version", {tone: "warn", text: "A newer version of this page exists — hard-reload (Ctrl/Cmd+Shift+R)."});
  return false;
}

function hostRepo() {
  const host = location.hostname;
  if (!host.endsWith("github.io")) return null;
  const owner = host.split(".")[0];
  const seg = location.pathname.split("/").filter(Boolean)[0];
  return seg && !seg.includes(".") ? `${owner}/${seg}` : `${owner}/${host}`;
}

function adoptRepoFromMeta() {
  if (!sync.health.repo && typeof state.meta?.repo === "string") sync.setRepo(state.meta.repo);
}

/* ------------------------------------------------------------------ data loading */

async function loadRoles() {
  try {
    const res = await fetch(`roles.json?ts=${Date.now()}`, {cache: "no-store"});
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), {status: res.status});
    adoptBotRoles(await res.json());
  } catch (e) {
    if (!(await rolesViaApi())) {
      state.rolesError = e;
      showBanner("roles-error", {
        tone: "err", alert: true,
        text: `Couldn't load roles.json (${e.status ? `HTTP ${e.status}` : e.message}). Open the page via its GitHub Pages URL and make sure the bot has run.`,
        actions: [{label: "Retry", run: () => loadRoles()}],
      });
    }
  }
  state.rolesLoaded = true;
  mergeRoles();
  render();
}

async function rolesViaApi() {
  if (!sync.health.hasPat) return false;
  try {
    const r = await sync.getFile("roles.json");
    if (!r.exists) return false;
    adoptBotRoles(r.json);
    return true;
  } catch {
    return false;
  }
}

function adoptBotRoles(json) {
  if (!Array.isArray(json)) throw new Error("roles.json is not a list");
  state.botRoles = json.filter(validRole);
  state.rolesError = null;
  hideBanner("roles-error");
}

function validRole(r) {
  return !!r && typeof r === "object" && typeof r.id === "string" && typeof r.company === "string" && typeof r.title === "string";
}

function mergeRoles() {
  const seen = new Set(state.botRoles.map((r) => r.id));
  state.roles = [...state.botRoles, ...state.manualRoles.filter((r) => !seen.has(r.id))];
}

async function loadMeta() {
  try {
    const r = await sync.getFile("meta.json");
    state.meta = r.exists && r.json && typeof r.json === "object" && !Array.isArray(r.json) ? r.json : null;
    state.metaKnown = true;
  } catch {
    state.meta = null;
  }
  adoptRepoFromMeta();                       // before the stale-scan banner, whose "Open Actions" link needs the repo
  updateScanPill(true);
  checkStaleScan();
}

async function loadLists() {
  await Promise.all([loadManual(), loadCompanies(), loadConfig()]);
}

async function loadManual() {
  try {
    const r = await sync.getFile("manual.json");
    state.manualRoles = Array.isArray(r.json) ? r.json.filter(validRole) : [];
    state.lists.manual = true;
    mergeRoles();
    render();
  } catch (e) {
    console.warn("manual.json:", humanizeError(e, {pat: sync.health.hasPat}));
  }
}

async function loadCompanies() {
  try {
    const r = await sync.getFile("companies.json");
    state.companies = Array.isArray(r.json) ? dedupe(r.json.map(norm)) : [];
    state.lists.companies = true;
  } catch (e) {
    console.warn("companies.json:", humanizeError(e, {pat: sync.health.hasPat}));
  }
}

async function loadConfig() {
  try {
    const r = await sync.getFile("config.json");
    state.configFile = r.exists && r.json && typeof r.json === "object" && !Array.isArray(r.json) ? r.json : null;
    state.configSha = r.exists ? r.sha : null;
    state.lists.config = true;
    checkConfigStale();
  } catch (e) {
    console.warn("config.json:", humanizeError(e, {pat: sync.health.hasPat}));
  }
}

function effectiveConfig() {
  return {...structuredClone(DEFAULT_CONFIG), ...(state.configFile || {})};
}

/* ------------------------------------------------------------------ view state: hash ⇄ ui.v1 (§10.5) */

function readUi() {
  try {
    const raw = JSON.parse(store.get(KEYS.ui) || "{}");
    return {
      theme: ["auto", "light", "dark"].includes(raw.theme) ? raw.theme : "auto",
      view: raw.view, sort: raw.sort, cats: Array.isArray(raw.cats) ? raw.cats : [], hideClosed: raw.hideClosed !== false,
      collapsed: Array.isArray(raw.collapsed) ? raw.collapsed.filter((x) => typeof x === "string") : [],
      expanded: Array.isArray(raw.expanded) ? raw.expanded.filter((x) => typeof x === "string") : [],
    };
  } catch {
    return {theme: "auto", cats: [], hideClosed: true, collapsed: [], expanded: []};
  }
}

function saveUi() {
  const v = state.view;
  store.set(KEYS.ui, JSON.stringify({
    view: v.f, sort: v.s, cats: v.cat, hideClosed: v.hc, theme: state.ui.theme,
    collapsed: [...state.collapsed].slice(-200), expanded: [...state.expanded].slice(-200),
  }));
}

function initialView() {
  if (location.hash.length > 1) return hashToView(location.hash);
  const u = state.ui;
  return hashToView(viewToHash({f: u.view, s: u.sort, cat: u.cats, hc: u.hideClosed}));
}

function setView(patch) {
  const next = {...state.view, ...patch};
  if (patch.f && patch.f !== state.view.f && patch.s === undefined) next.s = undefined;   // a new view gets its default sort
  state.view = hashToView(viewToHash(next));
  history.replaceState(null, "", viewToHash(state.view));
  saveUi();
  render();
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

/* ------------------------------------------------------------------ rendering (§10.9) */

function computeView() {
  return buildView(state.roles, sync.marks, state.view, nowS(), {lastVisitMs: state.lastVisitPrev, metaLastRunS: state.meta?.last_run ?? null});
}

function render() {
  if (state.editor) {
    state.renderQueued = true;
    updateChrome(computeView());             // counts stay honest while the note editor keeps the list frozen
    return;
  }
  const focus = captureFocus();
  const vb = computeView();
  state.vb = vb;
  updateChrome(vb);
  list.innerHTML = listHtml(vb);
  if (state.cursor && !cursorAnyEl()) state.cursor = null;
  applyCursor();
  restoreFocus(focus);
  updateNewBanner(vb.counts.new);
  renderFooter();
}

/** Sections of rows, or the empty/error box — never rows (manual ones included) over a roles.json load error (§10.14). */
function listHtml(vb) {
  return vb.rows.length && !state.rolesError ? vb.sections.map((s) => sectionHtml(s, vb)).join("") : emptyHtml(vb);
}

/** Count shown next to view `f` everywhere (tabs, More menu, sticky bar, phone sheet): "–" while roles.json is unreadable (§10.2 step 3), so no surface shows a number derived from manual roles alone. */
function viewCount(f, counts) {
  return state.rolesError ? "–" : String(counts[f] ?? 0);
}

function updateChrome(vb) {
  const v = vb.view;
  const count = (f) => viewCount(f, vb.counts);
  for (const el of $$("[data-count]")) el.textContent = count(el.dataset.count);
  for (const tab of $$(".tab[data-view]")) tab.setAttribute("aria-current", tab.dataset.view === v.f ? "true" : "false");
  const more = $("#moreViews");
  const inMore = [...more.options].some((o) => o.value === v.f);
  for (const o of more.options) if (o.value) o.textContent = `${VIEW_LABEL[o.value]} (${count(o.value)})`;
  more.value = inMore ? v.f : "";
  more.parentElement.classList.toggle("on", inMore);
  $("#sort").value = v.s;
  for (const chip of $$(".chip[data-cat]")) chip.setAttribute("aria-pressed", v.cat.includes(chip.dataset.cat) ? "true" : "false");
  $("#hideClosedWrap").hidden = v.f !== "all";
  $("#hideClosed").checked = v.hc;
  for (const input of [$("#search"), $("#sbSearch")]) if (input.value !== v.q && document.activeElement !== input) input.value = v.q;
  $("#sbViewName").textContent = VIEW_LABEL[v.f];
  $("#sbViewCount").textContent = count(v.f);
}

function sectionHtml(section, vb) {
  const v = vb.view;
  const key = section.key;
  const rows = section.rows.map((row) => rowHtml(row, vb)).join("");
  if (v.s === "company") {
    const collapsed = state.collapsed.has(norm(key));
    const todo = section.rows.reduce((n, r) => n + r.members.filter((m) => m.stage === "todo").length, 0);
    const fresh = section.rows.reduce((n, r) => n + r.members.filter((m) => m.isNew).length, 0);
    const id = domId("sec", key);
    return `<section class="company${collapsed ? " collapsed" : ""}" data-key="${esc(key)}">
      <h2><button class="cotoggle" data-act="cotoggle" aria-expanded="${!collapsed}" aria-controls="${id}"><span class="chev" aria-hidden="true"></span>${esc(section.name)} <span class="n">${section.count}</span></button>
        ${collapsed && fresh ? `<span class="badge new">NEW ${fresh}</span>` : ""}<span class="rule" aria-hidden="true"></span>
        <span class="coacts"${todo ? "" : " hidden"}><button class="btn small menu" data-act="comenu" aria-label="Actions for ${esc(section.name)}" aria-expanded="false">…</button><button class="btn small" data-act="coseen">Seen all</button><button class="btn small" data-act="codismiss">Dismiss all…</button></span></h2>
      <div class="rows" id="${id}">${rows}</div></section>`;
  }
  if (v.f === "pipeline" && v.s === "updated") {
    return `<section class="stage" data-key="${esc(key)}"><h2>${esc(section.name)} <span class="n">${section.count}</span><span class="rule" aria-hidden="true"></span></h2><div class="rows">${rows}</div></section>`;
  }
  return `<section class="flat" data-key=""><div class="rows">${rows}</div></section>`;
}

function rowHtml(row, vb) {
  const v = vb.view;
  const group = row.ids.length > 1;
  const lead = leadMember(row);
  const name = rowName(row);
  const open = group && (state.expanded.has(row.key) || state.pendingAsk?.key === row.key);
  const closed = row.members.every((m) => m.role.active === false);
  const gid = domId("g", row.key);
  const attrs = `class="row${open ? " open" : ""}" data-key="${esc(row.key)}" data-id="${esc(row.id)}" data-ids="${esc(row.ids.join(" "))}" data-state="${stageAttr(row.stage)}"${closed ? ' data-closed="1"' : ""}`;
  const title = group
    ? `${titleHtml(lead.role, row.title)} <span class="n">×${row.ids.length}</span>`
    : titleHtml(lead.role, row.title);
  const body = `<div class="body" data-part="body">
      <div data-part="title">${title}</div>
      <div class="meta" data-part="meta">${metaHtml(row, v, lead)}${group ? "" : ` ${noteButtonHtml(lead)}`}</div>
      ${stageLineHtml(lead.entry, row.stage)}
      ${group ? `${open ? "" : notePreviewHtml(lead)}${membersHtml(row, gid, open)}` : notePreviewHtml(lead)}
    </div>`;
  const controls = controlsHtml(row, null, v, name);
  const members = open ? expandedHtml(row, v, gid) : "";
  return `<article ${attrs}>${starHtml(row.star, name)}${body}${controls}${members}</article>`;
}

function leadMember(row) {
  return row.members.find((m) => m.stage === row.stage) || row.members[0];
}

function rowName(row) {
  return `${row.company} — ${row.title}${row.ids.length > 1 ? ` (×${row.ids.length})` : ""}`;
}

function memberName(m) {
  return `${m.role.company} — ${m.role.title} (${locationsOf(m.role).join(", ") || "location N/A"})`;
}

function stageAttr(stage) {
  return STAGES.includes(stage) ? stage : "todo";
}

function titleHtml(role, text) {
  const url = safeUrl(role.url);
  if (!url) return `<span class="t">${esc(text)}</span>`;
  return `<a class="t" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-describedby="newtab">${esc(text)}<span class="ext" aria-hidden="true">↗</span></a>`;
}

function safeUrl(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
}

function starHtml(on, name) {
  return `<button class="star" data-part="star" data-act="star" aria-pressed="${on ? "true" : "false"}" aria-label="Save: ${esc(name)}">${on ? "★" : "☆"}</button>`;
}

function metaHtml(row, v, lead) {
  const parts = [];
  const role = lead.role;
  if (v.s !== "company") parts.push(`<span class="co">${esc(row.company)}</span>`);
  const locs = dedupe(row.members.flatMap((m) => locationsOf(m.role)));
  if (locs.length) parts.push(esc(locs.join("; ")));
  if (role.manual) parts.push(`added by you ${timeHtml(role.added || role.date_posted, "", "")}`);
  else if (Number.isFinite(row.newest) && row.newest > 0) parts.push(`posted ${timeHtml(row.newest)}`);
  if (role.category) parts.push(esc(role.category));
  if (row.ids.length === 1) {
    const deg = degreeTag(role.degrees);
    if (deg) parts.push(esc(deg));
  }
  if (row.isNew) parts.push('<span class="badge new">NEW</span>');
  if (row.members.some((m) => m.role.sponsorship === "Offers Sponsorship")) parts.push("sponsors");
  const closedNote = closedHtml(row);
  if (closedNote) parts.push(closedNote);
  return parts.join(" · ");
}

function closedHtml(row) {
  if (!row.members.every((m) => m.role.active === false)) return "";
  const untracked = row.members.find((m) => m.role.in_feed === true);
  if (untracked) return `<span class="badge neutral">not tracked: ${esc(WHY_LABEL[untracked.role.why] || "no longer matches")}</span>`;
  const at = row.closed || Math.max(0, ...row.members.map((m) => Number(m.role.last_seen) || 0));
  return `<span class="closed">closed${at ? ` ${timeHtml(at)}` : ""}</span>`;
}

function timeHtml(ts, prefix = "", suffix = "") {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  return `<time class="rel" data-ts="${ts}" title="${esc(isoDate(ts))}">${esc(prefix + rel(ts, nowS()) + suffix)}</time>`;
}

function stageLineHtml(entry, stage) {
  if (!isMark(entry) || !entry.s) return "";
  const parts = [`<b>${esc(STAGE_LABEL[entry.s].toLowerCase())}</b> ${entry.t ? timeHtml(entry.t) : "date unknown"}`];
  const applied = (entry.h || []).find((h) => h.s === "applied" && h.t);
  if (applied && entry.s !== "applied") parts.push(`applied ${esc(isoDate(applied.t))}`);
  if (PIPELINE.has(stage) && entry.t && nowS() - entry.t > NUDGE_S) parts.push(`<span class="nudge">no update ${esc(rel(entry.t, nowS()).replace(" ago", ""))}</span>`);
  return `<div class="stageline" data-part="stageline">${parts.join(" · ")}</div>`;
}

function noteOf(m) {
  return isMark(m.entry) ? m.entry.note || "" : "";
}

function noteButtonHtml(m) {
  const note = noteOf(m);
  return `<button class="notebtn${note ? " has" : ""}" data-act="note" aria-label="Notes for ${esc(memberName(m))}">${note ? "edit note" : "+ note"}</button>`;
}

function notePreviewHtml(m) {
  const note = noteOf(m);
  return note ? `<div class="note" data-part="note">${esc(note)}</div>` : "";
}

function membersHtml(row, gid, open) {
  const phdMixed = row.members.some((m) => isPhdOnly(m.role)) && !row.members.every((m) => isPhdOnly(m.role));
  const chips = row.members.map((m) => {
    const bits = [locationsOf(m.role).join(", ") || "location N/A", degreeTag(m.role.degrees)].filter(Boolean);
    const label = `${bits.join(" · ")} · ${STAGE_LABEL[m.stage]}`;
    const inner = `<span class="sd" data-s="${stageAttr(m.stage)}" aria-hidden="true"></span>${esc(bits.join(" · "))}${phdMixed && isPhdOnly(m.role) ? ' <span class="badge phd">PhD</span>' : ""}`;
    const url = safeUrl(m.role.url);
    return url
      ? `<a class="mchip" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-describedby="newtab" aria-label="${esc(label)} — open posting">${inner}</a>`
      : `<span class="mchip" aria-label="${esc(label)}">${inner}</span>`;
  }).join("");
  return `<div class="members" data-part="members"><button class="expand" data-act="expand" aria-expanded="${open}" aria-controls="${gid}">${open ? "Hide postings" : `${row.ids.length} postings`}</button>${chips}</div>`;
}

function isPhdOnly(role) {
  return Array.isArray(role.degrees) && role.degrees.length > 0 && role.degrees.every((d) => d === "PhD" || d === "MD");
}

function expandedHtml(row, v, gid) {
  const ask = state.pendingAsk?.key === row.key ? state.pendingAsk : null;
  const askHtml = ask
    ? `<p class="ask" data-part="ask">Which posting did you ${askVerb(ask.stage)}? <button class="linkbtn" data-act="askall">apply to all ${row.ids.length}</button> <button class="linkbtn" data-act="askcancel">cancel</button></p>`
    : "";
  const rows = row.members.map((m) => memberRowHtml(m, v, ask)).join("");
  return `<div class="gmembers" data-part="gmembers" id="${gid}">${askHtml}${rows}</div>`;
}

function askVerb(stage) {
  return {applied: "apply to", oa: "get the OA for", interview: "interview for", offer: "get the offer for", rejected: "get rejected from", seen: "see", dropped: "dismiss", todo: "return to review"}[stage] || "mean";
}

function memberRowHtml(m, v, ask) {
  const name = memberName(m);
  const deg = degreeTag(m.role.degrees);
  const meta = [locationsOf(m.role).join(", ") || "location N/A", `posted ${timeHtml(m.role.date_posted)}`, deg, m.isNew ? '<span class="badge new">NEW</span>' : ""].filter(Boolean).join(" · ");
  const controls = ask
    ? `<div class="quick" data-part="quick"><button class="qbtn pick" data-act="pick" data-s="${stageAttr(ask.stage)}" aria-label="${esc(STAGE_LABEL[ask.stage])}: ${esc(name)}">${esc(STAGE_LABEL[ask.stage])}</button></div>`
    : controlsHtml(null, m, v, name);
  return `<div class="mrow" data-part="m:${esc(m.id)}" data-mid="${esc(m.id)}" data-state="${stageAttr(m.stage)}">${starHtml(m.star, name)}<div class="body" data-part="body">
      <div data-part="title">${titleHtml(m.role, m.role.title)}</div><div class="meta" data-part="meta">${meta} ${noteButtonHtml(m)}</div>${stageLineHtml(m.entry, m.stage)}${notePreviewHtml(m)}</div>${controls}</div>`;
}

function controlsHtml(row, member, v, name) {
  const stage = member ? member.stage : row.stage;
  if (QUICK_VIEWS.has(v.f) && stage === "todo") {
    return `<div class="quick" data-part="quick">
      <button class="qbtn seen" data-act="stage" data-s="seen" aria-label="Mark ${esc(name)} as Seen">Seen</button>
      <button class="qbtn applied" data-act="stage" data-s="applied" aria-label="Mark ${esc(name)} as Applied">Applied</button>
      <button class="qbtn dismiss" data-act="stage" data-s="dropped" aria-label="Dismiss ${esc(name)}">Dismiss</button></div>`;
  }
  const options = STAGES.map((s) => `<option value="${s}"${s === stage ? " selected" : ""}>${esc(STAGE_LABEL[s])}</option>`).join("");
  return `<span class="stagewrap" data-part="quick"><select class="stagesel" data-act="stagesel" aria-label="Stage for ${esc(name)}">${options}</select></span>`;
}

function emptyHtml(vb) {
  const v = vb.view;
  const label = VIEW_LABEL[v.f];
  const box = (big, small = "", actions = []) => `<div class="empty"><div class="big">${big}</div>${small}${actions.length ? `<div class="acts">${actions.map(([act, text]) => `<button class="btn" data-act="${act}">${text}</button>`).join("")}</div>` : ""}</div>`;
  if (state.rolesError) return box("Couldn't load roles.json", "Open the page via its GitHub Pages URL and make sure the bot has run.");
  if (v.q) return box(`No matches for ‘${esc(v.q)}’ in ${label}.`, "", [["searchall", "Search all views"], ["clearq", "Clear search"]]);
  if (v.cat.length) return box(`No ${esc(v.cat.join("/"))} roles in ${label}.`, "", [["clearcat", "Clear chips"]]);
  if (v.co) return box(`No roles at ‘${esc(v.co)}’ in ${label}.`, "", [["clearco", "Clear company"]]);
  switch (v.f) {
    case "inbox": return box("Inbox zero.", `Nothing left to review — next scan ${esc(nextScanText())}.`);
    case "new": return box(state.lastVisitPrev ? `Nothing new since your last visit (${esc(fmtLocal(state.lastVisitPrev))}).` : "Nothing new yet.", "New roles appear here for 36 hours after the bot finds them.");
    case "pipeline": return box("No applications in flight.", "Mark a role Applied and it shows up here with its date.");
    case "star": return box("No saved roles.", "Tap the star to save one.");
    case "all": return box(state.roles.length ? "Nothing here yet." : "No roles yet — run the workflow once from the Actions tab.");
    case "closed": case "untracked": return box("Nothing here yet.");
    default: return box(`Nothing marked ${label}.`);
  }
}

function nextScanText() {
  const last = Number(state.meta?.last_run);
  if (!last) return "within ~2 h";
  const hours = Math.max(1, Math.ceil((last + 2 * HOUR - nowS()) / HOUR));
  return `in ~${hours} h`;
}

/* ------------------------------------------------------------------ patching (§10.9) */

function onRemoteMarks(ids) {
  if (!state.rolesLoaded) return;
  patchRows(ids);
}

function patchRows(ids) {
  if (!state.vb || !state.rolesLoaded) return;
  const prev = state.vb;
  const vb = computeView();
  state.vb = vb;
  updateChrome(vb);
  if (state.rolesError || !vb.rows.length || !prev.rows.length || !list.querySelector("section")) {
    if (!state.editor) {
      const focus = captureFocus();
      list.innerHTML = listHtml(vb);
      if (state.cursor && !cursorAnyEl()) state.cursor = null;
      applyCursor();
      restoreFocus(focus);
    }
    renderFooter();
    updateNewBanner(vb.counts.new);
    return;
  }
  const focus = captureFocus();
  const cursorPlan = planCursor();
  const touched = new Set(ids);
  const keys = new Set();
  for (const r of prev.rows) if (r.ids.some((id) => touched.has(id))) keys.add(r.key);
  for (const r of vb.rows) if (r.ids.some((id) => touched.has(id))) keys.add(r.key);
  const fresh = new Map(vb.rows.map((r) => [r.key, r]));
  const sectionOf = new Map();
  for (const s of vb.sections) for (const r of s.rows) sectionOf.set(r.key, s.key);
  for (const key of keys) {
    const el = rowEl(key);
    const row = fresh.get(key);
    if (row && el) {
      if (el.closest("section")?.dataset.key === sectionOf.get(key)) replaceRow(el, row, vb);
      else moveRow(el, row, vb);
    } else if (row) insertRow(row, vb);
    else if (el) removeRow(el);
  }
  syncSections(vb);
  settleCursor(cursorPlan);
  applyCursor();
  restoreFocus(focus);
  renderFooter();
  updateNewBanner(vb.counts.new);
}

function rowEl(key) {
  return list.querySelector(`.row[data-key="${cssq(key)}"]:not(.leaving)`);
}

function replaceRow(el, row, vb) {
  const fresh = html(rowHtml(row, vb));
  if (state.editor && el.contains(state.editor.el)) graft(el, fresh);
  else el.replaceWith(fresh);
}

/** Patch `old` to look like `fresh` without disturbing the subtree that hosts the open note editor. */
function graft(old, fresh) {
  for (const attr of [...old.attributes]) if (!fresh.hasAttribute(attr.name) && attr.name !== "class") old.removeAttribute(attr.name);
  for (const attr of [...fresh.attributes]) old.setAttribute(attr.name, attr.name === "class" ? `${attr.value}${old.classList.contains("cur") ? " cur" : ""}` : attr.value);
  const editorEl = state.editor.el;
  const oldParts = new Map([...old.children].map((c) => [c.dataset.part, c]));
  const freshParts = [...fresh.children];
  const keepParts = new Set(["editor"]);
  for (const part of freshParts) {
    const name = part.dataset.part;
    const current = oldParts.get(name);
    if (current && current.contains(editorEl)) {
      if (name === "body" || name === "gmembers" || name.startsWith("m:")) graft(current, part);
      keepParts.add(name);
    } else if (editorEl.parentElement === old && name === "note") {
      keepParts.add(name);    // the editor lives in this body: its live preview shows the draft, not the committed note
    } else if (current) {
      current.replaceWith(part);
      keepParts.add(name);
    } else {
      const next = freshParts.slice(freshParts.indexOf(part) + 1).map((p) => oldParts.get(p.dataset.part)).find(Boolean)
        || (editorEl.parentElement === old ? editorEl : null);   // new parts go above the open editor, never below it
      old.insertBefore(part, next);
      keepParts.add(name);
    }
  }
  for (const [name, node] of oldParts) if (!keepParts.has(name) && !node.contains(editorEl)) node.remove();
}

function insertRow(row, vb) {
  const section = vb.sections.find((s) => s.rows.some((r) => r.key === row.key));
  if (!section) return null;
  let secEl = list.querySelector(`section[data-key="${cssq(section.key)}"]:not(.leaving)`);
  if (!secEl) {
    secEl = html(sectionHtml({...section, rows: []}, vb));
    const after = vb.sections.slice(vb.sections.indexOf(section) + 1).map((s) => list.querySelector(`section[data-key="${cssq(s.key)}"]`)).find(Boolean);
    list.insertBefore(secEl, after || null);
  }
  const rowsEl = secEl.querySelector(".rows");
  const fresh = html(rowHtml(row, vb));
  const following = section.rows.slice(section.rows.indexOf(section.rows.find((r) => r.key === row.key)) + 1).map((r) => rowEl(r.key)).find(Boolean);
  rowsEl.insertBefore(fresh, following || null);
  return fresh;
}

/** The row changed section (Pipeline stage groups): rebuild it there and keep focus on the same control (§10.9). */
function moveRow(el, row, vb) {
  if (state.editor && el.contains(state.editor.el)) dropEditor();
  const active = el.contains(document.activeElement) ? document.activeElement : null;
  fadeOut(el);
  const fresh = insertRow(row, vb);
  if (!active || !fresh) return;
  const sel = controlSelector(active);
  ((sel && fresh.querySelector(sel)) || firstControl(fresh))?.focus({preventScroll: true});
}

/** Fade a row out; focus (never the cursor — see settleCursor) moves to the next row, or the previous one when it was last. */
function removeRow(el) {
  if (state.editor && el.contains(state.editor.el)) dropEditor();
  const had = el.contains(document.activeElement);
  const neighbour = had ? siblingRow(el, 1) || siblingRow(el, -1) : null;
  fadeOut(el);
  if (!had) return;
  if (neighbour) focusFirstControl(neighbour);
  if (!neighbour?.contains(document.activeElement)) activeTab().focus({preventScroll: true});
}

/** Mark `el` as leaving (every row/section query skips it from now on) and detach it after the fade. */
function fadeOut(el) {
  el.classList.add("leaving");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) el.remove();
  else setTimeout(() => el.remove(), FADE_MS);
}

function siblingRow(el, dir) {
  const rows = visibleRows();
  const i = rows.indexOf(el);
  return rows[i + dir] || null;
}

function syncSections(vb) {
  const live = new Map(vb.sections.map((s) => [s.key, s]));
  for (const secEl of $$("section:not(.leaving)", list)) {
    const s = live.get(secEl.dataset.key);
    if (!s) {
      retireSection(secEl);
      continue;
    }
    const n = secEl.querySelector("h2 .n");
    if (n) n.textContent = String(s.count);
    const acts = secEl.querySelector(".coacts");
    if (!acts) continue;
    const hasTodo = s.rows.some((r) => r.members.some((m) => m.stage === "todo"));
    if (hasTodo && acts.hidden) restoreCompanyActs(secEl);      // never resurface a stale "Dismiss N roles?" confirm
    acts.hidden = !hasTodo;
  }
}

/** A section whose rows all left: hand focus to the next visible row (the last one when it was the final section), then fade. */
function retireSection(secEl) {
  if (secEl.contains(document.activeElement)) {
    const rows = visibleRows();
    const target = rows.find((r) => secEl.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) || rows.at(-1);
    if (target) focusFirstControl(target);
    if (!target?.contains(document.activeElement)) activeTab().focus({preventScroll: true});
  }
  fadeOut(secEl);
}

/* ------------------------------------------------------------------ focus + cursor */

/** Rows a user can reach: not fading out and not inside a collapsed company (§10.7) or a retiring section. */
function visibleRows() {
  return $$(".row:not(.leaving)", list).filter((r) => !r.closest("section.collapsed, section.leaving"));
}

function captureFocus() {
  const a = document.activeElement;
  if (!a || !list.contains(a)) return null;
  const row = a.closest(".row");
  const mrow = a.closest(".mrow");
  return {key: row?.dataset.key || null, mid: mrow?.dataset.mid || null, sel: controlSelector(a), index: visibleRows().indexOf(row)};
}

function controlSelector(a) {
  if (a.dataset.act) return `[data-act="${a.dataset.act}"]${a.dataset.s ? `[data-s="${a.dataset.s}"]` : ""}`;
  if (a.matches("select.stagesel")) return "select.stagesel";
  if (a.matches("a.t")) return "a.t";
  return null;
}

function restoreFocus(f) {
  if (!f) return;
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected && a !== list && !a.closest(".leaving")) return;      // focus already moved somewhere valid
  const rows = visibleRows();
  let target = f.key ? rowEl(f.key) : null;
  if (target && f.mid) target = target.querySelector(`.mrow[data-mid="${cssq(f.mid)}"]`) || target;
  if (!target && rows.length) target = rows[Math.min(Math.max(f.index, 0), rows.length - 1)];
  if (!target) {
    activeTab().focus({preventScroll: true});
    return;
  }
  const control = (f.sel && target.querySelector(f.sel)) || firstControl(target);
  control?.focus({preventScroll: true});
}

function firstControl(rowEl) {
  return rowEl.querySelector(".quick button, select.stagesel, .expand, .star, a.t");
}

function focusFirstControl(rowEl) {
  firstControl(rowEl)?.focus({preventScroll: true});
}

function activeTab() {
  return $(".tab[aria-current=true]") || $(".tab");
}

/** Cursor stops in document order: rows and, inside expanded groups, member rows — hidden ones only when `all`. */
function cursorStops(all = false) {
  const stops = $$(".row:not(.leaving), .row.open:not(.leaving) .mrow", list);
  return all ? stops : stops.filter((el) => !el.closest("section.collapsed, section.leaving"));
}

const stopId = (el) => el.dataset.mid || el.dataset.key;

function cursorEls() {
  return cursorStops();
}

function cursorEl() {
  return state.cursor ? cursorEls().find((el) => stopId(el) === state.cursor) || null : null;
}

/** The cursor's element even while a collapsed company hides it (null once it has left the DOM). */
function cursorAnyEl() {
  return state.cursor ? cursorStops(true).find((el) => stopId(el) === state.cursor) || null : null;
}

/**
 * Taken before a patch: the ids the cursor should fall to if its row leaves — the following members of its group,
 * then the group row, then the following stops, then the preceding ones (§10.9 "successor row").
 */
function planCursor() {
  const el = cursorEl();
  if (!el) return null;
  const stops = cursorEls();
  const i = stops.indexOf(el);
  const after = stops.slice(i + 1);
  const group = el.dataset.mid ? el.closest(".row") : null;
  const inGroup = group ? after.filter((s) => group.contains(s)) : [];
  return [...inGroup.map(stopId), ...(group ? [group.dataset.key] : []), ...after.map(stopId), ...stops.slice(0, i).reverse().map(stopId)];
}

/** After a patch: when the cursor's element is gone, move the cursor to the first surviving candidate. */
function settleCursor(candidates) {
  if (!candidates || !state.cursor || cursorAnyEl()) return;
  const alive = new Set(cursorEls().map(stopId));
  state.cursor = candidates.find((id) => alive.has(id)) || null;
}

function applyCursor() {
  for (const el of $$(".cur", list)) {
    el.classList.remove("cur");
    el.removeAttribute("aria-current");
  }
  const el = cursorEl();
  if (el) {
    el.classList.add("cur");
    el.setAttribute("aria-current", "true");
  }
}

function moveCursor(dir) {
  const els = cursorEls();
  if (!els.length) return;
  const i = els.indexOf(cursorEl());
  const next = i >= 0 ? els[Math.min(Math.max(i + dir, 0), els.length - 1)] : stopFrom(els, cursorAnyEl(), dir);
  state.cursor = stopId(next);
  applyCursor();
  next.scrollIntoView({block: "nearest"});
}

/** Where j/k land when the cursor is hidden inside a collapsed company (continue from its place) or unset (the top). */
function stopFrom(els, anchor, dir) {
  if (!anchor) return els[0];
  const after = els.findIndex((el) => anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  if (dir > 0) return after < 0 ? els[els.length - 1] : els[after];
  return (after < 0 ? els[els.length - 1] : els[after - 1]) || els[0];
}

/* ------------------------------------------------------------------ mutations (§10.7, §10.16) */

function stageOf(entry) {
  return isMark(entry) && entry.s ? entry.s : "todo";
}

function pickMark(entry) {
  const out = {};
  if (isMark(entry)) {
    if (entry.s) out.s = entry.s;
    if (entry.star) out.star = true;
    if (entry.note) out.note = entry.note;
  }
  return out;
}

function nextEntry(prev, stage) {
  const base = pickMark(prev);
  delete base.s;
  if (stage === "todo") return base.star || base.note ? base : null;
  return {...base, s: stage};
}

/** Commit `mutate(prev)` for every id; returns the undo record (or null when nothing changed). */
function commitMany(ids, mutate) {
  const items = [];
  for (const id of ids) {
    const before = valueOf(pickMark(sync.marks[id]));
    const prev = sync.commit(id, mutate(sync.marks[id]), {silent: true});
    if (valueOf(pickMark(sync.marks[id])) !== before) items.push({id, prev});
  }
  return items.length ? {items} : null;
}

function setStage(ids, stage, {label} = {}) {
  const record = commitMany(ids, (prev) => nextEntry(prev, stage));
  if (!record) return;
  pushUndo(record);
  patchRows(record.items.map((i) => i.id));
  const verb = stage === "dropped" ? "Dismissed" : stage === "todo" ? "Returned to review" : `Marked ${STAGE_LABEL[stage]}`;
  toast(`${verb} ${label || describe(record.items[0].id)}`, {undo: true});
  announce(`${label || describe(record.items[0].id, true)} ${verb.toLowerCase()}. ${state.vb?.counts.inbox ?? 0} to review.`);
}

function describe(id, withCompany = false) {
  const role = state.roles.find((r) => r.id === id);
  if (!role) return "1 role";
  return withCompany ? `${role.company} — ${role.title}` : `‘${role.title}’`;
}

function toggleStar(ids) {
  const on = !ids.some((id) => isMark(sync.marks[id]) && sync.marks[id].star);
  const record = commitMany(ids, (prev) => {
    const base = pickMark(prev);
    if (on) return {...base, star: true};
    delete base.star;
    return base.s || base.note ? base : null;
  });
  if (!record) return;
  pushUndo(record);
  patchRows(ids);
  announce(on ? "Saved." : "Removed from Saved.");
}

function groupStage(row, stage) {
  const todo = row.members.filter((m) => m.stage === "todo").map((m) => m.id);
  if (stage === "seen" || stage === "dropped") {
    if (!todo.length) {
      state.expanded.add(row.key);
      saveUi();
      patchRows(row.ids);
      announce("Every posting in this group is already marked — change them one by one.");
      return;
    }
    setStage(todo, stage, {label: `${todo.length} of ${row.ids.length} postings`});
    return;
  }
  if (todo.length === 1) {
    setStage(todo, stage);
    return;
  }
  state.pendingAsk = {key: row.key, stage};
  patchRows(row.ids);
  const el = rowEl(row.key);
  el?.querySelector(".qbtn.pick")?.focus({preventScroll: true});
  announce(`Which posting did you ${askVerb(stage)}? Choose one below.`);
}

function clearAsk(key) {
  if (state.pendingAsk?.key !== key) return;
  state.pendingAsk = null;
}

function dismissCompany(sectionEl, stage) {
  const company = sectionEl.dataset.key;
  const ids = state.vb.rows.filter((r) => r.company === company).flatMap((r) => r.members.filter((m) => m.stage === "todo").map((m) => m.id));
  if (!ids.length) return;
  const record = commitMany(ids, (prev) => nextEntry(prev, stage));
  if (!record) return;
  const acts = sectionEl.querySelector(".coacts");
  if (acts.contains(document.activeElement)) sectionEl.querySelector(".cotoggle").focus({preventScroll: true});   // the actions hide once nothing is left to review
  restoreCompanyActs(sectionEl);
  pushUndo(record);
  patchRows(ids);
  const verb = stage === "dropped" ? "Dismissed" : "Marked seen";
  toast(`${verb} ${ids.length} roles at ${company}`, {undo: true});
  announce(`${verb} ${ids.length} roles at ${company}. ${state.vb?.counts.inbox ?? 0} to review.`);
}

function pushUndo(record) {
  state.undo.push(record);
  if (state.undo.length > UNDO_DEPTH) state.undo.shift();
}

function undo() {
  const record = state.undo.pop();
  if (!record) return;
  for (const {id, prev} of record.items) {
    if (prev === null) sync.commit(id, null, {silent: true});
    else sync.commit(id, prev, {restore: true, silent: true});
  }
  const ids = record.items.map((i) => i.id);
  patchRows(ids);
  const key = state.vb.rows.find((r) => r.ids.includes(ids[0]))?.key;
  if (key) {
    state.cursor = key;
    applyCursor();
    const el = rowEl(key);
    if (el) {
      el.scrollIntoView({block: "nearest"});
      focusFirstControl(el);
    }
  }
  hideToast();
  announce(`Undone: ${ids.length} ${ids.length === 1 ? "role" : "roles"} restored.`);
}

/* ------------------------------------------------------------------ notes editor (§10.8) */

function openEditor(id, hostBody, key) {
  if (state.editor) {
    if (state.editor.id === id) {
      state.editor.el.querySelector("textarea").focus();
      return;
    }
    closeEditor();
  }
  const role = state.roles.find((r) => r.id === id);
  const note = isMark(sync.marks[id]) ? sync.marks[id].note || "" : "";
  const name = role ? `${role.company} — ${role.title}` : id;
  const box = html(`<div class="noteedit" data-part="editor"><textarea aria-label="Notes for ${esc(name)}" placeholder="Notes — recruiter, dates, OA link, questions…"></textarea>
    <div class="acts"><button class="btn small primary" data-act="notedone">Done</button><span class="hint">Ctrl/Cmd+Enter to finish · Esc to close</span></div></div>`);
  const ta = box.querySelector("textarea");
  ta.value = note;
  hostBody.append(box);
  state.editor = {id, key, el: box, draft: note, idle: null};
  ta.addEventListener("input", () => {
    state.editor.draft = ta.value;
    previewNote(hostBody, ta.value);
    clearTimeout(state.editor.idle);
    state.editor.idle = setTimeout(() => {
      commitNote();
      sync.schedulePush(1000);
    }, NOTE_IDLE_MS);
  });
  ta.addEventListener("blur", () => {
    if (commitNote()) sync.flushNow();
  });
  ta.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" && (e.ctrlKey || e.metaKey)) || e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeEditor();
    }
  });
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function previewNote(body, text) {
  let pv = body.querySelector(':scope > [data-part="note"]');
  if (!text.trim()) {
    pv?.remove();
    return;
  }
  if (!pv) {
    pv = html('<div class="note" data-part="note"></div>');
    body.insertBefore(pv, state.editor?.el?.parentElement === body ? state.editor.el : null);
  }
  pv.textContent = text;
}

function commitNote() {
  const ed = state.editor;
  if (!ed) return false;
  clearTimeout(ed.idle);
  const text = ed.draft.trim();
  const current = isMark(sync.marks[ed.id]) ? sync.marks[ed.id].note || "" : "";
  if (text === current) return false;
  const base = pickMark(sync.marks[ed.id]);
  delete base.note;
  const next = text ? {...base, note: text} : (base.s || base.star ? base : null);
  sync.commit(ed.id, next, {silent: true});
  return true;
}

function closeEditor() {
  const ed = state.editor;
  if (!ed) return;
  if (commitNote()) sync.flushNow();
  dropEditor();
  const focusBack = rowEl(ed.key)?.querySelector(`.mrow[data-mid="${cssq(ed.id)}"] [data-act="note"], [data-act="note"]`);
  if (state.renderQueued) {
    state.renderQueued = false;
    render();
  } else patchRows([ed.id]);
  const btn = rowEl(ed.key)?.querySelector(`.mrow[data-mid="${cssq(ed.id)}"] [data-act="note"]`) || rowEl(ed.key)?.querySelector('[data-act="note"]') || focusBack;
  btn?.focus({preventScroll: true});
}

/** Forget the editor without re-rendering (its row is being removed or replaced). */
function dropEditor() {
  const ed = state.editor;
  if (!ed) return;
  commitNote();
  state.editor = null;
  ed.el.remove();
}

/* ------------------------------------------------------------------ events */

function wireEvents() {
  $(".skip").addEventListener("click", (e) => { e.preventDefault(); list.focus(); });   // no #list navigation: the view hash and the Back stack stay untouched
  list.addEventListener("click", onListClick);
  list.addEventListener("change", onListChange);
  list.addEventListener("focusin", onListFocus);
  for (const tab of $$(".tab[data-view]")) tab.addEventListener("click", () => setView({f: tab.dataset.view}));
  $("#moreViews").addEventListener("change", (e) => { if (e.target.value) setView({f: e.target.value}); });
  $("#sort").addEventListener("change", (e) => setView({s: e.target.value}));
  for (const chip of $$(".chip[data-cat]")) chip.addEventListener("click", () => toggleCat(chip.dataset.cat));
  $("#hideClosed").addEventListener("change", (e) => setView({hc: e.target.checked}));
  for (const input of [$("#search"), $("#sbSearch")]) input.addEventListener("input", () => scheduleSearch(input.value));
  $("#sbSearchBtn").addEventListener("click", toggleMobileSearch);
  $("#sbView").addEventListener("click", () => openSheet("views"));
  $("#sbSort").addEventListener("click", () => openSheet("sort"));
  $("#btnCompanies").addEventListener("click", () => openDialog("dlgCompanies"));
  $("#btnAddRole").addEventListener("click", () => openDialog("dlgAddRole"));
  $("#btnSettings").addEventListener("click", () => openDialog("dlgSettings"));
  $("#btnHelp").addEventListener("click", () => openDialog("dlgShortcuts"));
  $("#syncPill").addEventListener("click", () => openDialog("dlgSync"));
  $("#footCsv").addEventListener("click", () => exportView("csv"));
  $("#footJson").addEventListener("click", () => exportView("json"));
  wireDialogs();
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", () => { pointerHeld = true; }, true);
  for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, () => { pointerHeld = false; setTimeout(flushDeferred, 0); }, true);
  window.addEventListener("hashchange", () => {
    if (!/^#(f=|new$)/.test(location.hash)) {            // an in-page anchor (a typed/bookmarked #list), not a view
      if (location.hash === "#list") list.focus();
      history.replaceState(null, "", viewToHash(state.view));
      return;
    }
    const fromHash = viewToHash(hashToView(location.hash));
    if (fromHash !== viewToHash(state.view)) {
      state.view = hashToView(location.hash);
      saveUi();
      render();
    }
  });
  window.addEventListener("storage", (e) => {
    if (e.key === "jobwatch.marks.v3" || e.key === "jobwatch.dirty.v1") sync.absorbDisk();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") store.set(KEYS.lastVisit, String(Date.now()));
    else {
      refresh("visible");
      refreshRelDates();
    }
  });
  window.addEventListener("pagehide", () => store.set(KEYS.lastVisit, String(Date.now())));
  window.addEventListener("focus", () => refresh("focus"));
  window.addEventListener("pageshow", (e) => { if (e.persisted) refresh("pageshow"); });
  window.addEventListener("online", () => {
    hideBanner("pending-offline");
    sync.retry();
  });
  window.addEventListener("beforeunload", (e) => {
    if (sync.health.state === "busy" && sync.dirty.size) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  setInterval(() => { if (document.visibilityState === "visible") refresh("interval"); }, 5 * 60000);
  setInterval(tick, 30000);
}

/**
 * `--sticky-h` = the height of whatever is sticky — the wrapping header on desktop, the 48 px bar on phones — so cursor
 * and focus scrolling never land under it (§10.10; WCAG 2.4.11). A CSSOM write, which style-src 'self' allows.
 */
function trackStickyHeight() {
  const header = $("header");
  const bar = $(".stickybar");
  const update = () => {
    const sticky = getComputedStyle(header).position === "sticky" ? header : bar;
    document.documentElement.style.setProperty("--sticky-h", `${sticky.offsetHeight}px`);
  };
  update();
  const observer = new ResizeObserver(update);
  observer.observe(header);
  observer.observe(bar);                     // flips between 0 and 48 px at the phone breakpoint
}

function whenPointerIdle(fn) {
  if (!pointerHeld) fn();
  else deferred.push(fn);
}

function flushDeferred() {
  while (deferred.length && !pointerHeld) deferred.shift()();
}

let tickCount = 0;
function tick() {
  renderHealth(sync.health);
  if (++tickCount % 20 === 0) refreshRelDates();
  updateScanPill();
}

function refreshRelDates() {
  const now = nowS();
  for (const t of $$("time.rel[data-ts]", list)) {
    const ts = Number(t.dataset.ts);
    const text = t.textContent;
    const fresh = rel(ts, now);
    if (!text.endsWith(fresh)) t.textContent = fresh;
  }
}

function refresh(reason) {
  if (Date.now() - state.lastRefreshAt < REFRESH_THROTTLE_MS) return;
  state.lastRefreshAt = Date.now();
  if (sync.dirty.size && sync.health.hasPat) {
    sync.schedulePush(500);
    return;
  }
  loadRoles();
  loadMeta().then(() => sync.pull(reason));
}

function scheduleSearch(value) {
  clearTimeout(timers.search);
  timers.search = setTimeout(() => {
    if (value.trim() !== state.view.q) setView({q: value});
  }, 150);
}

function clearSearch() {
  clearTimeout(timers.search);               // a pending debounce must not re-apply the query after Esc
  for (const input of [$("#search"), $("#sbSearch")]) input.value = "";
  if (state.view.q) setView({q: ""});
}

function toggleCat(cat) {
  const cats = state.view.cat.includes(cat) ? state.view.cat.filter((c) => c !== cat) : [...state.view.cat, cat];
  setView({cat: cats});
}

function toggleMobileSearch() {
  const bar = $(".stickybar");
  const on = !bar.classList.contains("searching");
  bar.classList.toggle("searching", on);
  $("#sbSearchBtn").setAttribute("aria-pressed", on ? "true" : "false");
  if (on) $("#sbSearch").focus();
  else clearSearch();
}

function onListClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn || !list.contains(btn)) return;
  const act = btn.dataset.act;
  const sectionEl = btn.closest("section");
  if (act === "cotoggle") return toggleCompany(sectionEl);
  if (act === "comenu") {
    const acts = btn.closest(".coacts");
    acts.classList.toggle("open");
    btn.setAttribute("aria-expanded", acts.classList.contains("open") ? "true" : "false");
    return;
  }
  if (act === "coseen") return dismissCompany(sectionEl, "seen");
  if (act === "codismiss") return confirmCompanyDismiss(sectionEl, btn);
  if (act === "codismiss-yes") return dismissCompany(sectionEl, "dropped");
  if (act === "codismiss-no") {
    restoreCompanyActs(sectionEl);
    sectionEl.querySelector("[data-act=codismiss]").focus();
    return;
  }
  if (act === "searchall") return setView({f: "all", hc: false});
  if (act === "clearq") return clearSearch();
  if (act === "clearcat") return setView({cat: []});
  if (act === "clearco") return setView({co: ""});
  const rowElement = btn.closest(".row");
  if (!rowElement) return;
  const row = state.vb?.rows.find((r) => r.key === rowElement.dataset.key);
  if (!row) return;
  const mrow = btn.closest(".mrow");
  const member = mrow ? row.members.find((m) => m.id === mrow.dataset.mid) : null;
  state.cursor = member ? member.id : row.key;
  switch (act) {
    case "stage":
      if (member) setStage([member.id], btn.dataset.s);
      else if (row.ids.length === 1) setStage(row.ids, btn.dataset.s);
      else groupStage(row, btn.dataset.s);
      break;
    case "pick":
      clearAsk(row.key);
      setStage([member.id], btn.dataset.s);
      break;
    case "askall": {
      const stage = state.pendingAsk?.stage;
      clearAsk(row.key);
      if (stage) setStage(row.ids, stage, {label: `all ${row.ids.length} postings`});
      break;
    }
    case "askcancel":
      clearAsk(row.key);
      patchRows(row.ids);
      break;
    case "star":
      toggleStar(member ? [member.id] : row.ids);
      break;
    case "note":
      openEditor(member ? member.id : row.id, btn.closest(".body"), row.key);
      break;
    case "notedone":
      closeEditor();
      break;
    case "expand":
      toggleExpand(row);
      break;
    default:
      break;
  }
}

/** The cursor follows keyboard focus, so Tab and j/k agree on which row s/a/d/f/n/o act on (§10.10). */
function onListFocus(e) {
  const el = e.target instanceof Element ? e.target.closest(".row.open .mrow, .row") : null;
  if (!el || el.closest(".leaving")) return;
  const id = stopId(el);
  if (id === state.cursor) return;
  state.cursor = id;
  applyCursor();
}

function onListChange(e) {
  const sel = e.target.closest("select.stagesel");
  if (!sel) return;
  const rowElement = sel.closest(".row");
  const row = state.vb?.rows.find((r) => r.key === rowElement?.dataset.key);
  if (!row) return;
  const mrow = sel.closest(".mrow");
  const member = mrow ? row.members.find((m) => m.id === mrow.dataset.mid) : null;
  const stage = STAGES.includes(sel.value) ? sel.value : "todo";
  state.cursor = member ? member.id : row.key;
  if (member) setStage([member.id], stage);
  else if (row.ids.length === 1) setStage(row.ids, stage);
  else groupStage(row, stage);
}

function toggleExpand(row) {
  if (state.expanded.has(row.key)) {
    state.expanded.delete(row.key);
    clearAsk(row.key);
  } else state.expanded.add(row.key);
  saveUi();
  patchRows(row.ids);
  rowEl(row.key)?.querySelector(".expand")?.focus({preventScroll: true});
}

function toggleCompany(sectionEl) {
  const key = norm(sectionEl.dataset.key);
  if (state.collapsed.has(key)) state.collapsed.delete(key);
  else state.collapsed.add(key);
  saveUi();
  const collapsed = state.collapsed.has(key);
  sectionEl.classList.toggle("collapsed", collapsed);
  const toggle = sectionEl.querySelector(".cotoggle");
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  const fresh = state.vb.sections.find((s) => s.key === sectionEl.dataset.key)?.rows.reduce((n, r) => n + r.members.filter((m) => m.isNew).length, 0) || 0;
  sectionEl.querySelector("h2 .badge.new")?.remove();
  if (collapsed && fresh) toggle.insertAdjacentHTML("afterend", `<span class="badge new">NEW ${fresh}</span>`);
  applyCursor();
}

function confirmCompanyDismiss(sectionEl, btn) {
  const company = sectionEl.dataset.key;
  const n = state.vb.rows.filter((r) => r.company === company).reduce((k, r) => k + r.members.filter((m) => m.stage === "todo").length, 0);
  const acts = btn.closest(".coacts");
  acts.dataset.saved = acts.innerHTML;
  acts.innerHTML = `<span class="confirm">Dismiss ${n} roles at ${esc(company)}? <button class="btn small danger" data-act="codismiss-yes">Dismiss</button> <button class="btn small" data-act="codismiss-no">Cancel</button></span>`;
  acts.querySelector("[data-act=codismiss-yes]").focus();
}

/** Undo confirmCompanyDismiss(): put "Seen all / Dismiss all…" back (no-op when no confirm is showing). */
function restoreCompanyActs(sectionEl) {
  const acts = sectionEl.querySelector(".coacts");
  if (!acts?.dataset.saved) return;
  acts.innerHTML = acts.dataset.saved;
  delete acts.dataset.saved;
}

/* ------------------------------------------------------------------ keyboard (§10.10) */

function onKey(e) {
  if (e.defaultPrevented) return;
  const target = e.target;
  const inField = target instanceof Element && target.matches("input, textarea, select, [contenteditable]");
  if ($("dialog[open]")) return;
  if (inField) {
    if (e.key === "Escape" && (target.id === "search" || target.id === "sbSearch")) {
      clearSearch();
      target.blur();
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (state.pendingG) {
    state.pendingG = false;
    clearTimeout(timers.chord);
    const view = {i: "inbox", n: "new", p: "pipeline", s: "star", a: "all"}[e.key];
    if (view) {
      e.preventDefault();
      setView({f: view});
    }
    return;
  }
  const onControl = target instanceof Element && target.matches("button, a, select, input, textarea");
  switch (e.key) {
    case "j": case "ArrowDown": e.preventDefault(); moveCursor(1); break;
    case "k": case "ArrowUp": e.preventDefault(); moveCursor(-1); break;
    case "s": cursorStage("seen"); break;
    case "a": cursorStage("applied"); break;
    case "d": case "x": cursorStage("dropped"); break;
    case "f": cursorAct((row, member) => toggleStar(member ? [member.id] : row.ids)); break;
    case "o": openCursor(); break;
    case "Enter": if (!onControl) openCursor(); break;
    case "n": e.preventDefault(); cursorAct((row, member, el) => openEditor(member ? member.id : row.id, el.querySelector(':scope > .body') || el.querySelector(".body"), row.key)); break;
    case "e": cursorAct((row) => { if (row.ids.length > 1) toggleExpand(row); }); break;
    case "c": { const sec = cursorAnyEl()?.closest("section.company"); if (sec) toggleCompany(sec); break; }
    case "u": undo(); break;
    case "/": e.preventDefault(); focusSearch(); break;
    case "Escape": if (state.editor) closeEditor(); else if (state.view.q) clearSearch(); break;
    case "g": state.pendingG = true; timers.chord = setTimeout(() => { state.pendingG = false; }, 1000); break;
    case "1": case "2": case "3": case "4": toggleCat(CATS[Number(e.key) - 1]); break;
    case "?": e.preventDefault(); openDialog("dlgShortcuts"); break;
    default: break;
  }
}

/** Run `fn(row, member, el)` on the cursor row; without a cursor nothing is marked (§10.10 acts on "the cursor row"). */
function cursorAct(fn) {
  const el = cursorEl();
  if (!el) {
    announce("No row selected — press j to move to the first one.");
    return;
  }
  const rowElement = el.closest(".row");
  const row = state.vb?.rows.find((r) => r.key === rowElement.dataset.key);
  if (!row) return;
  const member = el.dataset.mid ? row.members.find((m) => m.id === el.dataset.mid) : null;
  state.cursor = member ? member.id : row.key;
  fn(row, member, el);
}

function cursorStage(stage) {
  cursorAct((row, member) => {
    if (member) setStage([member.id], stage);
    else if (row.ids.length === 1) setStage(row.ids, stage);
    else groupStage(row, stage);
  });
}

function openCursor() {
  cursorAct((row, member) => {
    const url = safeUrl((member || leadMember(row)).role.url);
    if (url) window.open(url, "_blank", "noopener");
  });
}

function focusSearch() {
  const desktop = $("#search");
  if (getComputedStyle(desktop).display !== "none") desktop.focus();
  else {
    if (!$(".stickybar").classList.contains("searching")) toggleMobileSearch();
    $("#sbSearch").focus();
  }
}

/* ------------------------------------------------------------------ banners (§10.13), toast, announcer */

function showBanner(id, {text, tone = "info", actions = [], dismiss = false, alert = false}) {
  const box = $("#banners");
  let el = box.querySelector(`.banner[data-id="${cssq(id)}"]`);
  const sig = JSON.stringify([tone, alert, dismiss, text, actions.map((a) => [a.label, a.href || ""])]);
  if (el?.dataset.sig === sig) return;          // unchanged — rebuilding a live region makes screen readers re-read it
  if (!el) {
    el = html(`<div class="banner" data-id="${esc(id)}"></div>`);
    box.append(el);
  }
  el.dataset.sig = sig;
  el.dataset.tone = tone;
  el.setAttribute("role", alert ? "alert" : "status");
  el.innerHTML = `<p></p><span class="acts"></span>${dismiss ? '<button class="x" aria-label="Dismiss notice">×</button>' : ""}`;
  el.querySelector("p").textContent = text;
  const acts = el.querySelector(".acts");
  for (const a of actions) {
    const b = a.href
      ? html(`<a class="btn small" target="_blank" rel="noopener noreferrer" aria-describedby="newtab"></a>`)
      : html('<button class="btn small"></button>');
    b.textContent = a.label;
    if (a.href) b.href = a.href;
    else b.addEventListener("click", () => a.run());
    acts.append(b);
  }
  el.querySelector(".x")?.addEventListener("click", () => {
    hideBanner(id);
    session(`jobwatch.banner.${id}`, "1");
  });
}

function hideBanner(id) {
  $(`#banners .banner[data-id="${cssq(id)}"]`)?.remove();
}

function bannerDismissed(id) {
  return session(`jobwatch.banner.${id}`) === "1";
}

function onEngineBanner(id, payload) {
  if (payload === null) return hideBanner(id);
  switch (id) {
    case "sync-err":
      return showBanner("sync-err", {
        tone: "err", alert: true,
        text: `Not syncing since ${fmtLocal(sync.health.errAt || Date.now())} — ${payload}. Your marks are safe on this device.`,
        actions: [{label: "Fix token", run: () => openDialog("dlgSync")}, {label: "Retry", run: () => sync.retry()}],
      });
    case "pending-offline":
      return showBanner("pending-offline", {tone: "warn", text: `You're offline — ${payload.n} ${payload.n === 1 ? "change" : "changes"} will sync when you're back.`});
    case "pending-retry":
      return showBanner("pending-retry", {tone: "warn", text: `GitHub isn't answering — ${payload.n} ${payload.n === 1 ? "change" : "changes"} waiting; retrying in a minute.`});
    case "mirror":
      if (bannerDismissed("mirror")) return;
      return showBanner("mirror", {
        tone: "warn", text: "Sync is off on this device — marks you make here are not saved to your repo.",
        actions: [{label: "Paste token", run: () => openDialog("dlgSync")}, {label: "Keep local", run: () => { hideBanner("mirror"); session("jobwatch.banner.mirror", "1"); }}],
      });
    case "local-orphans":
      return showBanner("local-orphans", {
        tone: "warn", text: `This device has ${payload.n} ${payload.n === 1 ? "mark" : "marks"} that are not in your repo.`,
        actions: [
          {label: "Push them", run: () => { payload.push(); hideBanner("local-orphans"); }},
          {label: "Discard", run: () => { payload.discard(); hideBanner("local-orphans"); }},
        ],
      });
    case "marks-corrupt":
      return showBanner("marks-corrupt", {tone: "warn", text: `Marks saved in this browser were unreadable and were set aside (${payload.key}). Your repo copy reloads on the next sync.`, dismiss: true});
    default:
      return undefined;
  }
}

/** Same gate as viewCount(): while roles.json is unreadable the New count would come from manual roles alone, so the banner stays hidden too. */
function updateNewBanner(count) {
  if (count > 0 && !state.rolesError && state.view.f !== "new" && !bannerDismissed("new")) {
    showBanner("new", {tone: "info", text: `${count} new ${count === 1 ? "role" : "roles"} since your last visit`, dismiss: true, actions: [{label: "Show new", run: () => setView({f: "new"})}]});
  } else hideBanner("new");
}

function checkStaleScan() {
  const last = Number(state.meta?.last_run);
  if (last && nowS() - last > STALE_SCAN_S) {
    const hours = Math.floor((nowS() - last) / HOUR);
    const repo = sync.health.repo;
    showBanner("stale-scan", {
      tone: "warn", text: `The bot hasn't scanned in ${hours} h — check the Actions tab.`,
      actions: repo ? [{label: "Open Actions", href: `https://github.com/${repo}/actions`}] : [],
    });
  } else hideBanner("stale-scan");
}

function checkConfigStale() {
  const known = state.meta && Object.prototype.hasOwnProperty.call(state.meta, "config_sha") && state.configSha !== undefined;
  if (known && sync.health.hasPat && state.configSha !== state.meta.config_sha) {
    showBanner("config-stale", {tone: "info", text: "Settings changed since the last scan — a scan will pick them up within ~2 h.", actions: [{label: "Rescan", run: () => { openDialog("dlgCompanies"); runRescan({dispatch: true}); }}]});
  } else hideBanner("config-stale");
}

function toast(text, {undo: withUndo = false} = {}) {
  const box = $("#toast");
  box.innerHTML = "";
  box.append(document.createTextNode(text));
  if (withUndo) {
    const b = html('<button class="linkbtn">Undo</button>');
    b.addEventListener("click", undo);
    box.append(b);
  }
  clearTimeout(timers.toast);
  timers.toast = setTimeout(hideToast, TOAST_MS);
}

function hideToast() {
  $("#toast").innerHTML = "";
}

function announce(text) {
  const el = $("#announce");
  el.textContent = "";
  setTimeout(() => { el.textContent = text; }, 30);
}

/* ------------------------------------------------------------------ health pill + footer (§10.4.7) */

function renderHealth(h) {
  const pill = $("#syncPill");
  const label = {
    off: ["Local only", "none"], mirror: ["Read-only", "warn"], local: ["Sync off", "none"],
    on: [`Synced ${agoShort(h.okAt)}`, "ok"], busy: ["Syncing…", "busy"],
    pending: [`${h.pending} unsaved`, "warn"], err: ["Sync failing", "err"],
  }[h.state] || ["Local only", "none"];
  $("#syncText").textContent = label[0];
  pill.dataset.tone = label[1];
  pill.title = h.err ? `Last error: ${h.err}` : h.okAt ? `Last success ${fmtLocal(h.okAt)}` : "Open Sync settings";
  renderFooter();
  if ($("#dlgSync").open) renderSyncHealth();
}

function renderFooter() {
  const h = sync?.health;
  if (!h) return;
  const words = {
    off: "No repo known — marks stay on this device. Roles and companies load from the files next to this page; set owner/repo and a token in Sync to read from and write to a repo.",
    mirror: "Read-only mirror — marks stay on this device until you add a token.",
    local: "Sync is off on this device.",
    on: `synced ${agoShort(h.okAt)}${h.pushedAt ? ` · last change pushed ${fmtLocal(h.pushedAt)}` : ""}`,
    busy: "syncing…",
    pending: `${h.pending} ${h.pending === 1 ? "change" : "changes"} waiting to sync`,
    err: `NOT synced — last success ${h.okAt ? agoShort(h.okAt) : "never"}`,
  }[h.state];
  $("#footSync").textContent = words || "";
  $("#footScan").textContent = $("#scanText").textContent;
}

/* ------------------------------------------------------------------ scan pill (§10.13) */

async function updateScanPill(force = false) {
  if (!state.metaKnown) return;
  const meta = state.meta;
  if (sync.health.hasPat && sync.health.repo) {
    if (force || Date.now() - state.scanPillAt > SCAN_PILL_MIN_INTERVAL_MS) {
      state.scanPillAt = Date.now();
      try {
        const runs = await sync.api(`/repos/${sync.health.repo}/actions/workflows/jobwatch.yml/runs?per_page=1&status=success`);
        const run = runs?.workflow_runs?.[0];
        state.lastSuccessfulRunMs = run ? Date.parse(run.updated_at || run.created_at) : null;
      } catch {
        state.lastSuccessfulRunMs = null;          // no Actions read on this token — meta.json wording below
      }
    }
    if (state.lastSuccessfulRunMs) {
      const at = state.lastSuccessfulRunMs;
      const h = (Date.now() - at) / 3600000;
      return setScanPill(`scanned ${agoShort(at)}`, h <= 4 ? "ok" : h <= 26 ? "warn" : "err", `${scanTooltip()}\nlast successful run: ${new Date(at).toISOString().replace("T", " ").slice(0, 16)} UTC`);
    }
  }
  const last = Number(meta?.last_run);
  if (!last) {
    const seen = Math.max(0, ...state.botRoles.map((r) => Number(r.last_seen) || 0));
    return setScanPill("scan time unknown", "none", seen ? `meta.json is missing (old bot). Newest last_seen: ${fmtUTC(seen)}` : "meta.json is missing — the v2 bot has not run yet");
  }
  const h = (nowS() - last) / HOUR;
  setScanPill(`bot alive ${agoShort(last * 1000)}`, h <= 22 ? "ok" : h <= 26 ? "warn" : "err", `${scanTooltip()}\nthe bot commits only when something changed; this is its last commit or heartbeat`);
}

function setScanPill(text, tone, title) {
  $("#scanText").textContent = text;
  $("#scanPill").dataset.tone = tone;
  $("#scanPill").title = title;
  $("#footScan").textContent = text;
}

function scanTooltip() {
  const m = state.meta || {};
  const result = {
    ok: "ok", "ok-no-change": "ok, no change", "telegram-failed": "Telegram delivery failed; roles will be re-sent", "telegram-partial": "Telegram partially delivered; the rest will be re-sent",
  }[m.last_result] || "unknown";
  const tg = m.telegram?.mode ? ` · Telegram: ${m.telegram.mode}` : "";
  return `last run: ${m.last_run ? fmtUTC(m.last_run) : "unknown"} · result: ${result}${tg}`;
}

/* ------------------------------------------------------------------ dialogs (§10.15) */

function openDialog(id) {
  const dlg = $(`#${id}`);
  if (dlg.open) return;
  const opener = document.activeElement;
  dlg.addEventListener("close", () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus({preventScroll: true}); }, {once: true});
  ({dlgCompanies: renderCompanies, dlgSettings: renderSettings, dlgSync: renderSync, dlgAddRole: renderAddRole}[id] || (() => {}))();
  dlg.showModal();
}

function openSheet(kind) {
  const ul = $(kind === "views" ? "#viewsList" : "#sortList");
  const counts = state.vb?.counts || {};
  const items = kind === "views"
    ? Object.keys(VIEW_LABEL).map((f) => [f, VIEW_LABEL[f], viewCount(f, counts), f === state.view.f])
    : Object.keys(SORT_LABEL).map((s) => [s, SORT_LABEL[s], null, s === state.view.s]);
  ul.innerHTML = items.map(([v, label, n, cur]) => `<li><button data-v="${esc(v)}"${cur ? ' aria-current="true"' : ""}>${esc(label)}${n === null ? "" : ` <span class="n">${n}</span>`}</button></li>`).join("");
  const dlg = $(kind === "views" ? "#dlgViews" : "#dlgSort");
  ul.onclick = (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    dlg.close();
    setView(kind === "views" ? {f: b.dataset.v} : {s: b.dataset.v});
  };
  openDialog(dlg.id);
}

function wireDialogs() {
  for (const dlg of $$("dialog")) {
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg || e.target.closest("[data-close]")) dlg.close();
    });
  }
  wireCompanies();
  wireSettings();
  wireSync();
  wireAddRole();
}

function confirmDialog(text, {ok = "Confirm", title = "Are you sure?"} = {}) {
  const dlg = $("#dlgConfirm");
  $("#dlgConfirmTitle").textContent = title;
  $("#confirmText").textContent = text;
  $("#confirmOk").textContent = ok;
  return new Promise((resolve) => {
    let answer = false;
    const yes = () => { answer = true; dlg.close(); };
    const no = () => dlg.close();
    $("#confirmOk").addEventListener("click", yes, {once: true});
    $("#confirmCancel").addEventListener("click", no, {once: true});
    dlg.addEventListener("close", () => {
      $("#confirmOk").removeEventListener("click", yes);
      $("#confirmCancel").removeEventListener("click", no);
      resolve(answer);
    }, {once: true});
    dlg.showModal();
  });
}

function setMsg(id, text, kind = "") {
  const el = $(`#${id}`);
  el.className = `msg${kind ? ` ${kind}` : ""}`;
  el.textContent = text || "";
}

function editReason(file) {
  if (!sync.health.hasPat) return "Turn on Sync (token) to edit.";
  if (!state.lists[file]) return "This list has not loaded yet — reload the page first.";
  return null;
}

function errorText(e) {
  return e?.name === "UIError" ? e.message : humanizeError(e, {pat: true, repo: sync.health.repo});
}

/* --- Companies */

function wireCompanies() {
  $("#coSearch").addEventListener("input", renderCompanyChips);
  $("#coInput").addEventListener("input", previewCompany);
  $("#coInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addCompany(); } });
  $("#coAdd").addEventListener("click", addCompany);
  $("#coBlock").addEventListener("click", blockCompany);
  $("#coRescan").addEventListener("click", () => runRescan({dispatch: true}));
  $("#coChips").addEventListener("click", onChipClick);
}

function renderCompanies() {
  const reason = editReason("companies");
  for (const id of ["coAdd", "coBlock", "coRescan"]) $(`#${id}`).disabled = !!reason;
  $("#coInput").disabled = !!reason;
  if (reason && !state.rescanning) setMsg("coMsg", reason, "warn");
  renderCompanyChips();
  previewCompany();
}

function keywordStats(kw) {
  const k = state.meta?.keywords?.[kw];
  if (k) return {active: Number(k.active) || 0, allTime: Number(k.all_time) || 0, denied: Number(k.denied) || 0, names: Array.isArray(k.names) ? k.names : []};
  const re = new RegExp(`(?<![a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`);
  const rows = state.botRoles.filter((r) => re.test(norm(r.company)));
  return {active: rows.filter((r) => r.active !== false).length, allTime: rows.length, denied: 0, names: dedupe(rows.map((r) => r.company)).slice(0, 5)};
}

function renderCompanyChips() {
  const box = $("#coChips");
  if (!state.companies) {
    box.innerHTML = '<span class="msg warn">Company list not loaded.</span>';
    return;
  }
  const q = norm($("#coSearch").value);
  const open = new Set($$(".kw.open", box).map((el) => el.dataset.kw));
  const disabled = !!editReason("companies");
  const focus = chipFocus(box);
  box.innerHTML = state.companies.filter((kw) => !q || kw.includes(q)).map((kw) => {
    const s = keywordStats(kw);
    const cnt = s.allTime === 0
      ? `<span class="cnt zero" title="never matched a company name in the feed">0 ever</span>`
      : `<span class="cnt">${s.active}</span>`;
    const denied = s.denied ? ` <span class="cnt denied">denied ${s.denied}</span>` : "";
    const names = open.has(kw) ? `<span class="names">${s.names.length ? `matches: ${esc(s.names.join(", "))}` : "no display names recorded yet"}</span>` : "";
    return `<span class="kw${open.has(kw) ? " open" : ""}" data-kw="${esc(kw)}"><button class="linkbtn name" data-kwname aria-expanded="${open.has(kw)}">${esc(kw)}</button> ${cnt}${denied}<button class="rm" data-kwx aria-label="Remove ${esc(kw)}"${disabled ? " disabled" : ""}>×</button>${names}</span>`;
  }).join("") || '<span class="msg">No keywords match.</span>';
  restoreChipFocus(box, focus);
}

/** Where focus sits inside the chip list (the rebuild below destroys it): which keyword, its index, and whether on ×. */
function chipFocus(box) {
  const a = document.activeElement;
  const chip = box.contains(a) ? a.closest(".kw") : null;
  if (!chip) return null;
  return {kw: chip.dataset.kw, index: $$(".kw", box).indexOf(chip), remove: !!a.closest("[data-kwx], [data-kwno], [data-kwyes]")};
}

/** Same keyword (same control) when it survived, else the chip now at its index, else the filter box. */
function restoreChipFocus(box, f) {
  if (!f) return;
  const chips = $$(".kw", box);
  const same = chips.find((c) => c.dataset.kw === f.kw);
  const chip = same || chips[Math.min(f.index, chips.length - 1)];
  const control = chip && ((f.remove && same && chip.querySelector("[data-kwx]:not([disabled])")) || chip.querySelector("[data-kwname]"));
  (control || $("#coSearch")).focus({preventScroll: true});
}

function onChipClick(e) {
  const chip = e.target.closest(".kw");
  if (!chip) return;
  const kw = chip.dataset.kw;
  if (e.target.closest("[data-kwname]")) {
    chip.classList.toggle("open");
    e.target.closest("[data-kwname]").setAttribute("aria-expanded", chip.classList.contains("open") ? "true" : "false");
    renderCompanyChips();
    return;
  }
  if (e.target.closest("[data-kwx]")) {
    const s = keywordStats(kw);
    if (!s.active) return removeCompany(kw);
    chip.innerHTML = `<span class="confirm">Removing ‘${esc(kw)}’ hides ${s.active} roles — they become ‘not tracked’. <button class="btn small danger" data-kwyes>Remove</button> <button class="btn small" data-kwno>Cancel</button></span>`;
    chip.querySelector("[data-kwyes]").focus();
    return;
  }
  if (e.target.closest("[data-kwyes]")) return removeCompany(kw);
  if (e.target.closest("[data-kwno]")) renderCompanyChips();
}

function previewCompany() {
  const raw = $("#coInput").value;
  const kw = norm(raw);
  if (!raw.trim()) return setMsg("coPreview", "");
  if (state.companies?.includes(kw)) return setMsg("coPreview", `‘${kw}’ is already tracked.`, "warn");
  setMsg("coPreview", kw && kw !== raw.trim() ? `will match as: ${kw}` : kw ? "" : "That normalises to nothing — use letters or digits.", kw ? "" : "err");
}

async function addCompany() {
  const raw = $("#coInput").value.trim();
  const kw = norm(raw);
  if (!kw) return;
  if (state.companies?.includes(kw)) return setMsg("coMsg", `‘${kw}’ is already tracked.`, "warn");
  const saved = kw === raw.toLowerCase() ? `Saved ‘${kw}’` : `Saved ‘${raw}’ (as ‘${kw}’)`;
  if (!(await saveCompanies({add: kw}, `${saved} — a scan starts within a minute (push trigger).`, kw))) return;   // keep the input on failure
  $("#coInput").value = "";
  previewCompany();
}

async function removeCompany(kw) {
  await saveCompanies({remove: kw}, `Removed ‘${kw}’ — its roles become ‘not tracked’ after the scan that starts within a minute.`);
}

/** @returns {Promise<boolean>} true when the list was written (and the follow-up scan is being watched) */
async function saveCompanies(op, okText, followKeyword = null) {
  const reason = editReason("companies");
  if (reason) {
    setMsg("coMsg", reason, "err");
    return false;
  }
  setMsg("coMsg", "Saving…");
  try {
    const next = await sync.saveList("companies.json", op, (x) => x, {
      confirmEmpty: () => confirmDialog("Track nothing? Every role becomes ‘not tracked’ on the next scan.", {ok: "Save empty list", title: "Empty company list"}),
    });
    if (next === null) {
      setMsg("coMsg", "Kept the current list.");
      return false;
    }
    state.companies = next;
    renderCompanyChips();
    setMsg("coMsg", okText, "ok");
    runRescan({dispatch: false, forKeyword: followKeyword, prefix: okText});
    return true;
  } catch (e) {
    setMsg("coMsg", `Save failed: ${errorText(e)}`, "err");
    return false;
  }
}

async function blockCompany() {
  const name = norm($("#coInput").value);
  if (!name) return setMsg("coMsg", "Type the company name to block first.", "warn");
  const reason = editReason("config");
  if (reason) return setMsg("coMsg", reason, "err");
  const deny = dedupe([...(Array.isArray(state.configFile?.deny) ? state.configFile.deny : DEFAULT_CONFIG.deny), name]);
  setMsg("coMsg", "Saving config.json…");
  try {
    await saveConfig({...(state.configFile || {}), deny});
    setMsg("coMsg", `Blocked ‘${name}’ in config.deny — a scan starts within a minute.`, "ok");
    $("#coInput").value = "";
    previewCompany();
  } catch (e) {
    setMsg("coMsg", `Save failed: ${errorText(e)}`, "err");
  }
}

async function saveConfig(next) {
  const saved = await sync.saveList("config.json", {set: next});
  state.configFile = saved;
  try {
    const r = await sync.getFile("config.json");
    state.configSha = r.exists ? r.sha : null;
  } catch {
    state.configSha = undefined;
  }
  checkConfigStale();
  return saved;
}

/* --- Rescan (§10.15.1) */

/** Follow a scan and narrate it in #coMsg; `prefix` (a save confirmation) stays in front of every progress line. */
async function runRescan({dispatch, forKeyword = null, prefix = ""}) {
  if (state.rescanning) return;
  const reason = sync.health.hasPat ? null : "Turn on Sync (token) first.";
  if (reason) return setMsg("coMsg", reason, "err");
  state.rescanning = true;
  $("#coRescan").disabled = true;
  const known = new Set(state.botRoles.filter((r) => r.active !== false).map((r) => r.id));
  const say = (text, kind = "") => setMsg("coMsg", prefix ? `${prefix} ${text}` : text, kind);
  try {
    for await (const ev of sync.rescan({dispatch, knownIds: known})) {
      switch (ev.type) {
        case "started": say(dispatch ? "Scan started — following the run…" : "Watching for the scan the save triggered…"); break;
        case "waiting": say("Waiting for the run to appear…"); break;
        case "queued": say("Queued…"); break;
        case "queued-long": say("Queued behind a scheduled scan — still waiting…"); break;
        case "running": say("Scanning…"); break;
        case "superseded": say("Superseded by another scan — watching the newer run"); break;
        case "fallback": say("This token can't read Actions — watching roles.json for changes instead…"); break;
        case "done": finishRescan(ev, forKeyword); break;
        case "failed": say("Scan failed — ", "err"); appendRunLink(ev.url); break;
        case "timeout": case "error": say(ev.message, "err"); break;
        default: break;
      }
    }
  } catch (e) {
    say(`Rescan failed: ${errorText(e)}`, "err");
  } finally {
    state.rescanning = false;
    $("#coRescan").disabled = !!editReason("companies");
  }
}

function finishRescan(ev, forKeyword) {
  if (Array.isArray(ev.roles)) {
    adoptBotRoles(ev.roles);
    mergeRoles();
    if (ev.meta && typeof ev.meta === "object") {
      state.meta = ev.meta;
      updateScanPill(true);
      checkStaleScan();
      checkConfigStale();
    }
    render();
  }
  const added = ev.added || [];
  let text;
  if (added.length) {
    const byCo = new Map();
    for (const r of added) byCo.set(r.company, (byCo.get(r.company) || 0) + 1);
    const parts = [...byCo].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([co, n]) => `${n} ${co}`);
    text = `Scan finished: +${added.length} new ${added.length === 1 ? "role" : "roles"} (${parts.join(", ")}${byCo.size > 4 ? ", …" : ""})`;
  } else text = ev.viaSha ? "List updated — no new matches" : `Scan finished — no new matches${forKeyword ? ` for ‘${forKeyword}’` : ""}`;
  setMsg("coMsg", text, "ok");
  toast(text);
  announce(text);
}

function appendRunLink(url) {
  const safe = safeUrl(url);
  if (!safe) return;
  const a = html(`<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer" aria-describedby="newtab">open run</a>`);
  $("#coMsg").append(a);
}

/* --- Settings */

function wireSettings() {
  for (const r of $$('input[name="theme"]')) r.addEventListener("change", () => {
    state.ui.theme = r.value;
    applyTheme(r.value);
    saveUi();
  });
  const bind = (id, mutate) => {
    const el = $(`#${id}`);
    el.addEventListener("focus", syncTogglesFromText);
    el.addEventListener("change", () => editConfigText((cfg) => mutate(cfg, el)));
  };
  bind("optHw", (cfg, el) => { cfg.hardware_rescue = {...(cfg.hardware_rescue || DEFAULT_CONFIG.hardware_rescue), enabled: el.checked}; });
  bind("optResearch", (cfg, el) => { cfg.research_title = el.checked ? [...DEFAULT_CONFIG.research_title] : []; });
  bind("optUS", (cfg, el) => toggleRegion(cfg, "US", el));
  bind("optTW", (cfg, el) => toggleRegion(cfg, "TW", el));
  bind("optQuiet", (cfg, el) => { cfg.telegram = {...(cfg.telegram || DEFAULT_CONFIG.telegram), quiet_hours: el.checked ? quietFromFields() : null}; });
  for (const id of ["optQStart", "optQEnd", "optQTz"]) {
    $(`#${id}`).addEventListener("change", () => editConfigText((cfg) => { cfg.telegram = {...(cfg.telegram || DEFAULT_CONFIG.telegram), quiet_hours: quietFromFields()}; }));
  }
  $("#cfgValidate").addEventListener("click", () => {
    const parsed = parseConfigText();
    if (!parsed) return;
    const check = validateConfig(parsed);
    showValidation(check, check.ok ? "Valid — every key has the right type and every pattern compiles." : "");
  });
  $("#cfgSave").addEventListener("click", saveSettings);
  $("#cfgReset").addEventListener("click", async () => {
    if (!(await confirmDialog("Reset config.json to {}? The bot falls back to its built-in defaults on the next scan.", {ok: "Reset"}))) return;
    await saveConfigFromSettings({});
  });
  $("#expCsv").addEventListener("click", () => exportView("csv"));
  $("#expJson").addEventListener("click", () => exportView("json"));
  $("#clearLocal").addEventListener("click", async () => {
    if (!(await confirmDialog("Clear every stage, star and note stored in this browser? Your repo copy is untouched and reloads on the next sync.", {ok: "Clear local marks", title: "Clear local marks"}))) return;
    sync.clearLocal();
    location.reload();
  });
}

function toggleRegion(cfg, region, el) {
  const regions = Array.isArray(cfg.regions) ? [...cfg.regions] : [...DEFAULT_CONFIG.regions];
  const next = el.checked ? dedupe([...regions, region]) : regions.filter((r) => r !== region);
  if (!next.length) {
    el.checked = true;
    setMsg("cfgMsg", "At least one region — or type [] in the JSON below to accept every country.", "warn");
    return;
  }
  cfg.regions = next;
}

function quietFromFields() {
  return {start: clampHour($("#optQStart").value, 23), end: clampHour($("#optQEnd").value, 8), tz: $("#optQTz").value.trim() || "America/Los_Angeles"};
}

function clampHour(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

function renderSettings() {
  for (const r of $$('input[name="theme"]')) r.checked = r.value === state.ui.theme;
  const reason = editReason("config");
  $("#cfgSave").disabled = !!reason;
  $("#cfgReset").disabled = !!reason;
  const source = state.configFile ? "config.json" : "defaults";
  const warnings = Array.isArray(state.meta?.warnings) ? state.meta.warnings : [];
  const info = $("#cfgInfo");
  info.className = `msg${warnings.length ? " warn" : ""}`;
  info.textContent = `${reason ? `${reason} · ` : ""}source: ${source}${state.meta?.config_source ? ` (bot: ${state.meta.config_source})` : ""}${warnings.length ? ` · bot warnings: ${warnings.join("; ")}` : ""}`;
  $("#cfgText").value = JSON.stringify(effectiveConfig(), null, 2);
  setMsg("cfgMsg", "");
  syncTogglesFromText();
}

function parseConfigText() {
  try {
    const parsed = JSON.parse($("#cfgText").value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config must be a JSON object");
    return parsed;
  } catch (e) {
    setMsg("cfgMsg", `Not valid JSON: ${e.message}`, "err");
    return null;
  }
}

function editConfigText(mutate) {
  const cfg = parseConfigText();
  if (!cfg) {
    syncTogglesFromText();
    return;
  }
  mutate(cfg);
  $("#cfgText").value = JSON.stringify(cfg, null, 2);
  syncTogglesFromText();
}

function syncTogglesFromText() {
  let cfg;
  try {
    cfg = JSON.parse($("#cfgText").value);
  } catch {
    return;
  }
  if (!cfg || typeof cfg !== "object") return;
  const eff = {...DEFAULT_CONFIG, ...cfg};
  $("#optHw").checked = eff.hardware_rescue?.enabled !== false;
  $("#optResearch").checked = Array.isArray(eff.research_title) && eff.research_title.length > 0;
  const regions = Array.isArray(eff.regions) ? eff.regions : [];
  $("#optUS").checked = regions.includes("US");
  $("#optTW").checked = regions.includes("TW");
  const quiet = eff.telegram?.quiet_hours;
  $("#optQuiet").checked = !!quiet;
  $("#quietFields").hidden = !quiet;
  if (quiet && typeof quiet === "object") {
    $("#optQStart").value = quiet.start ?? 23;
    $("#optQEnd").value = quiet.end ?? 8;
    $("#optQTz").value = quiet.tz ?? "America/Los_Angeles";
  }
}

function showValidation(check, okText) {
  const el = $("#cfgMsg");
  el.className = `msg ${check.ok ? "ok" : "err"}`;
  el.innerHTML = "";
  el.append(document.createTextNode(check.ok ? okText : `${check.errors.length} problem${check.errors.length === 1 ? "" : "s"}:`));
  const items = [...check.errors, ...(check.warnings || []).map((w) => `warning: ${w}`)];
  if (items.length) {
    const ul = document.createElement("ul");
    for (const it of items) {
      const li = document.createElement("li");
      li.textContent = it;
      ul.append(li);
    }
    el.append(ul);
  }
}

async function saveSettings() {
  const parsed = parseConfigText();
  if (!parsed) return;
  const check = validateConfig(parsed);
  if (!check.ok) return showValidation(check, "");
  await saveConfigFromSettings(parsed);
}

async function saveConfigFromSettings(next) {
  const reason = editReason("config");
  if (reason) return setMsg("cfgMsg", reason, "err");
  setMsg("cfgMsg", "Saving config.json…");
  try {
    await saveConfig(next);
    renderSettings();
    setMsg("cfgMsg", "Saved — a scan starts within a minute and picks the new settings up.", "ok");
  } catch (e) {
    setMsg("cfgMsg", `Save failed: ${errorText(e)}`, "err");
  }
}

function exportView(kind) {
  const rows = (state.vb?.rows || []).flatMap((r) => r.members.map((m) => ({
    company: m.role.company, title: m.role.title, location: locationsOf(m.role).join("; "), category: m.role.category || "",
    stage: m.stage, starred: m.star ? "yes" : "", note: isMark(m.entry) ? m.entry.note || "" : "", url: m.role.url || "",
    date_posted: m.role.date_posted ?? "", first_seen: m.role.first_seen ?? m.role.added ?? "", mark_t: isMark(m.entry) ? m.entry.t ?? "" : "",
  })));
  const stamp = isoDate(nowS());
  if (kind === "csv") download(`jobwatch-${state.view.f}-${stamp}.csv`, toCSV(rows, ["company", "title", "location", "category", "stage", "starred", "note", "url", "date_posted", "first_seen", "mark_t"]), "text/csv");
  else download(`jobwatch-${state.view.f}-${stamp}.json`, JSON.stringify(rows, null, 1), "application/json");
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* --- Sync */

function wireSync() {
  $("#syncSave").addEventListener("click", saveSync);
  $("#patIn").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveSync(); } });
  $("#syncOff").addEventListener("click", () => {
    sync.setOff(true);
    sync.setPat(null);
    hideBanner("sync-err");
    hideBanner("mirror");
    setMsg("syncMsg", "Sync turned off on this device — marks stay saved here.", "ok");
    renderSync();
    refreshEditability();
  });
  $("#syncRetry").addEventListener("click", () => {
    setMsg("syncMsg", "Retrying…");
    sync.retry();
  });
  $("#syncTrash").addEventListener("click", () => download(`jobwatch-trash-${isoDate(nowS())}.json`, store.get(KEYS.trash) || "[]", "application/json"));
}

function renderSync() {
  const repo = store.get(KEYS.repo) || state.meta?.repo || hostRepo() || "";
  if (!$("#repoIn").value) $("#repoIn").value = repo;
  $("#patIn").value = "";
  $("#iosTip").hidden = navigator.standalone !== false;
  $("#syncRetry").disabled = !sync.health.hasPat;
  renderSyncHealth();
}

function renderSyncHealth() {
  const h = sync.health;
  const rows = [
    ["State", {off: "Local only (no repo known)", mirror: "Read-only mirror (no token)", local: "Off on this device", on: "On", busy: "Request in flight", pending: "Waiting to retry", err: "Failing"}[h.state] || h.state],
    ["Repo", h.repo || "—"],
    ["Last success", h.okAt ? fmtLocal(h.okAt) : "never"],
    ["Last error", h.err ? `${h.err}${h.errAt ? ` (${fmtLocal(h.errAt)})` : ""}` : "—"],
    ["Unsaved changes", String(h.pending)],
    ["Automatic pushes", h.halted ? `paused (${h.reason === "offline" ? "offline" : "hard error"}) — Retry, a new token, coming back online or a reload resumes them` : "active"],
  ];
  $("#syncHealth").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd><b>${esc(v)}</b></dd>`).join("");
}

async function saveSync() {
  const repo = $("#repoIn").value.trim();
  const pat = $("#patIn").value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return setMsg("syncMsg", "Enter the repository as owner/repo.", "err");
  if (!pat) {
    sync.setRepo(repo);
    sync.setOff(false);
    setMsg("syncMsg", "Repo saved — read-only mode. Paste a token to write marks to it.", "ok");
    renderSync();
    return sync.pull("repo-set");
  }
  if (location.protocol === "file:") return setMsg("syncMsg", "A token can't be stored on a file: page — serve the folder with `python3 -m http.server` (or open the GitHub Pages URL).", "err");
  setMsg("syncMsg", "Checking the token…");
  $("#syncSave").disabled = true;
  try {
    const r = await sync.verify(repo, pat);
    if (!r.ok) return setMsg("syncMsg", r.reason || "Token check failed.", "err");
    sync.setRepo(repo);
    sync.setPat(pat);
    sync.setOff(false);
    $("#patIn").value = "";
    hideBanner("mirror");
    setMsg("syncMsg", r.write === true ? "Token verified: read and write OK." : `Token verified for reading; write access is confirmed on your first change.${r.reason ? ` (${r.reason})` : ""}`, "ok");
    await sync.pull("token");
    await loadLists();
    refreshEditability();
    updateScanPill(true);
    renderSync();
  } catch (e) {
    setMsg("syncMsg", errorText(e), "err");
  } finally {
    $("#syncSave").disabled = false;
  }
}

function refreshEditability() {
  if ($("#dlgCompanies").open) renderCompanies();
  if ($("#dlgAddRole").open) renderAddRole();
  if ($("#dlgSettings").open) renderSettings();
}

/* --- + Role */

function wireAddRole() {
  $("#mAdd").addEventListener("click", addManualRole);
  $("#mTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addManualRole(); } });
  $("#mList").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-rm]");
    if (b) removeManualRole(b.dataset.rm);
  });
}

function renderAddRole() {
  const reason = editReason("manual");
  for (const id of ["mCompany", "mTitle", "mUrl", "mLoc", "mCat", "mAdd"]) $(`#${id}`).disabled = !!reason;
  setMsg("mMsg", reason || "", reason ? "warn" : "");
  $("#coList").innerHTML = dedupe(state.roles.map((r) => r.company)).sort().map((c) => `<option value="${esc(c)}"></option>`).join("");
  const box = $("#mList");
  box.innerHTML = state.manualRoles.length
    ? state.manualRoles.map((r) => `<div class="mitem"><span class="who">${esc(r.company)} — ${esc(r.title)}</span><button class="btn small" data-rm="${esc(r.id)}" aria-label="Remove ${esc(r.company)} — ${esc(r.title)}"${reason ? " disabled" : ""}>Remove</button></div>`).join("")
    : '<p>No hand-added roles yet.</p>';
}

async function addManualRole() {
  const reason = editReason("manual");
  if (reason) return setMsg("mMsg", reason, "err");
  const company = $("#mCompany").value.trim();
  const title = $("#mTitle").value.trim();
  const url = $("#mUrl").value.trim();
  const locations = $("#mLoc").value.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);   // "San Jose, CA; Taipei, Taiwan"
  const category = CATS.includes($("#mCat").value) ? $("#mCat").value : "SWE";
  if (!company || !title) return setMsg("mMsg", "Company and role title are required.", "err");
  if (url && !safeUrl(url)) return setMsg("mMsg", "The link must start with http:// or https:// (or be left empty).", "err");
  const now = nowS();
  const role = {
    id: `manual:${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, company, title, url,
    location: locations.slice(0, 3).join(", ") || "location N/A", category, posted: "added by you", date_posted: now, active: true, manual: true, added: now,
  };
  if (locations.length) role.locations = locations;
  setMsg("mMsg", "Saving…");
  try {
    state.manualRoles = (await sync.saveList("manual.json", {add: role})).filter(validRole);
    mergeRoles();
    render();
    renderAddRole();
    for (const id of ["mCompany", "mTitle", "mUrl", "mLoc"]) $(`#${id}`).value = "";
    setMsg("mMsg", `Added ‘${company} — ${title}’.`, "ok");
    announce(`Added ${company} — ${title}.`);
  } catch (e) {
    setMsg("mMsg", `Save failed: ${errorText(e)}`, "err");
  }
}

async function removeManualRole(id) {
  const role = state.manualRoles.find((r) => r.id === id);
  if (!role) return;
  setMsg("mMsg", "Removing…");
  try {
    state.manualRoles = (await sync.saveList("manual.json", {remove: role})).filter(validRole);
    if (sync.marks[id]) sync.commit(id, null, {silent: true});
    mergeRoles();
    render();
    renderAddRole();
    setMsg("mMsg", `Removed ‘${role.company} — ${role.title}’.`, "ok");
  } catch (e) {
    setMsg("mMsg", `Remove failed: ${errorText(e)}`, "err");
  }
}

/* ------------------------------------------------------------------ small helpers */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[m]));
}

/** Escape any string for use inside a quoted attribute selector (`[data-key="…"]`), control characters included. */
function cssq(s) {
  return CSS.escape(String(s));
}

function html(markup) {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

function domId(prefix, key) {
  let h = 5381;
  for (const ch of String(key)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `${prefix}-${h.toString(36)}`;
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}

function agoShort(ms) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function fmtLocal(ms) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? time : `${d.toLocaleDateString(undefined, {weekday: "short", month: "short", day: "numeric"})} ${time}`;
}

function fmtUTC(s) {
  return `${new Date(s * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

boot();
