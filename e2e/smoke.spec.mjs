// smoke (§12.3): every active role renders as a group row, no console errors, no external requests without a PAT,
// honest scan pill, keyboard sanity (Enter on Applied moves focus to the successor, ArrowDown on the stage select
// keeps focus, j/k/s/u once each), the cursor/focus contract of §10.9–§10.10 (the cursor follows focus and survives
// removals, nothing scrolls under the sticky header, the skip link keeps the view) and the a11y basics (unique
// accessible names, aria-pressed, live regions that do not churn, forced-colours indicators). Two extra servers cover
// a roles.json failure and a stale meta.json with a control-character company name.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {serveCopy, launch, watch, seedStorage, readJson, freshMeta, FIXTURES} from "./helpers.mjs";
import {buildView, parseMarks, groupKey} from "../assets/lib.js";

const roles = readJson(`${FIXTURES}/roles.json`);
const status = readJson(`${FIXTURES}/status.json`);
const manual = readJson(`${FIXTURES}/manual.json`);
const companies = readJson(`${FIXTURES}/companies.json`);
const GOV = groupKey("TikTok", "Machine Learning Engineer Graduate - E-Commerce Governance");
let srv;
let browser;

before(async () => {
  srv = await serveCopy({"roles.json": roles, "status.json": status, "companies.json": companies, "manual.json": manual, "meta.json": freshMeta()});
  browser = await launch();
});
after(async () => {
  await browser?.close();
  srv?.stop();
});

/** A fresh context per test (its own localStorage), watched for errors/external requests, with rows rendered. */
async function open(hash, {url = srv.url, height = 900, storage = null, ...contextOpts} = {}) {
  const context = await browser.newContext({viewport: {width: 1280, height}, ...contextOpts});
  const page = await context.newPage();
  if (storage) await seedStorage(page, storage);
  const watcher = watch(page, url);
  await page.goto(`${url}index.html${hash}`, {waitUntil: "networkidle"});
  await page.waitForSelector(".row");
  return {page, close: () => context.close(), ...watcher};
}

const rowKeys = (page) => page.locator(".row").evaluateAll((els) => els.map((e) => e.dataset.key));
const cursor = (page) => page.evaluate(() => { const el = document.querySelector("#list .cur"); return el ? el.dataset.mid || el.dataset.key : null; });
const gone = (page, key) => page.waitForFunction((k) => !document.querySelector(`.row[data-key="${k}"]:not(.leaving)`), key);
const marksOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("jobwatch.marks.v3") || "{}"));
const focusInfo = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return {tag: a.tagName, key: a.closest(".row")?.dataset.key ?? null, select: a.matches("select.stagesel"), act: a.dataset.act ?? null, view: a.dataset.view ?? null};
});

test("inbox renders every active role as a group row, offline, without errors", async () => {
  const {page, close, errors, external} = await open("#f=inbox");
  const expected = buildView([...roles, ...manual], parseMarks(status), {f: "inbox"}, Math.floor(Date.now() / 1000), {metaLastRunS: Math.floor(Date.now() / 1000) - 7200});
  assert.equal(await page.locator(".row").count(), expected.rows.length);
  const idsShown = new Set((await page.locator(".row").evaluateAll((els) => els.map((e) => e.dataset.ids))).flatMap((s) => s.split(" ")));
  assert.equal(idsShown.size, expected.total, "every Inbox id is present exactly once");
  assert.equal(await page.locator('[data-count="inbox"]').innerText(), String(expected.counts.inbox));
  assert.match(await page.locator("#scanText").innerText(), /^bot alive 2h ago$/);
  assert.equal(await page.locator("#syncText").innerText(), "Read-only");
  assert.deepEqual(external, [], "no external requests without a PAT");
  assert.deepEqual(errors, []);
  await close();
});

test("accessible names are unique per control and stars expose aria-pressed", async () => {
  const {page, close} = await open("#f=inbox");
  const names = await page.locator(".row .star").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  assert.equal(new Set(names).size, names.length, "star labels carry the role name");
  assert.ok(names.every((n) => n.startsWith("Save: ")));
  const pressed = await page.locator(".row .star").evaluateAll((els) => els.map((e) => e.getAttribute("aria-pressed")));
  assert.ok(pressed.every((p) => p === "true" || p === "false"));
  const quick = await page.locator('.row .qbtn[data-s="applied"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  assert.equal(new Set(quick).size, quick.length);
  assert.equal(await page.locator("a.t[target=_blank]").evaluateAll((els) => els.every((a) => a.rel.includes("noopener") && a.rel.includes("noreferrer") && a.getAttribute("aria-describedby") === "newtab")), true);
  await close();
});

test("Enter on Applied marks the row and moves focus to the successor row", async () => {
  const {page, close, errors} = await open("#f=inbox");
  const keys = await rowKeys(page);
  const first = page.locator(".row").first();
  const id = await first.getAttribute("data-id");
  await first.locator('.qbtn[data-s="applied"]').focus();
  await page.keyboard.press("Enter");
  await gone(page, keys[0]);
  assert.equal((await focusInfo(page)).key, keys[1], "focus lands on the successor row");
  assert.equal(await cursor(page), keys[1], "the cursor follows the hand-off");
  const marks = await marksOf(page);
  assert.equal(marks[id].s, "applied");
  assert.ok(Number.isInteger(marks[id].t) && Array.isArray(marks[id].h), "commit stamps t and h");
  await page.waitForFunction(() => /marked applied/i.test(document.getElementById("announce").textContent));
  assert.match(await page.locator("#toast").innerText(), /Marked Applied/);
  assert.deepEqual(errors, []);
  await close();
});

test("ArrowDown on a stage select keeps focus; j/k/s/u work once each", async () => {
  const {page, close, errors} = await open("#f=all");
  const row = page.locator(".row").first();
  const key = await row.getAttribute("data-key");
  await row.locator("select.stagesel").focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction((k) => document.querySelector(`.row[data-key="${k}"]`)?.dataset.state !== "todo", key);
  assert.equal(await page.evaluate(() => document.activeElement?.matches("select.stagesel")), true);
  assert.equal((await focusInfo(page)).key, key);
  await page.evaluate(() => document.activeElement.blur());

  await page.keyboard.press("j");                                   // the select change put the cursor on row 1
  assert.notEqual(await cursor(page), key, "j moves down");
  await page.keyboard.press("k");
  assert.equal(await cursor(page), key, "k moves back up");
  assert.equal(await page.locator(".row.cur").getAttribute("aria-current"), "true");
  const secondKey = await page.locator(".row").nth(1).getAttribute("data-key");
  await page.keyboard.press("j");
  await page.keyboard.press("s");
  await page.waitForFunction((k) => document.querySelector(`.row[data-key="${k}"]`)?.dataset.state === "seen", secondKey);
  await page.keyboard.press("u");
  await page.waitForFunction((k) => document.querySelector(`.row[data-key="${k}"]`)?.dataset.state === "todo", secondKey);
  assert.deepEqual(errors, []);
  await close();
});

test("letter keys act on the focused row (the cursor follows Tab) and on nothing when there is no cursor", async () => {
  const {page, close, errors} = await open("#f=inbox");
  const keys = await rowKeys(page);
  await page.locator('.tab[data-view="inbox"]').focus();
  await page.keyboard.press("s");
  await page.waitForFunction(() => /No row selected/.test(document.getElementById("announce").textContent));
  assert.equal(await page.locator("#list .cur").count(), 0);
  assert.equal(await page.locator(".row:not(.leaving)").count(), keys.length, "nothing was marked");

  await page.locator(".row").first().locator(".star").focus();
  for (let i = 0; i < 40 && (await focusInfo(page)).key !== keys[2]; i++) await page.keyboard.press("Tab");
  assert.equal((await focusInfo(page)).key, keys[2], "Tab reached the third row");
  assert.equal(await cursor(page), keys[2], "the cursor followed focus");
  const id = await page.locator(".row").nth(2).getAttribute("data-id");
  await page.keyboard.press("s");
  await gone(page, keys[2]);
  assert.equal((await marksOf(page))[id].s, "seen", "the focused row was marked");
  assert.equal(await page.locator(`.row[data-key="${keys[0]}"]`).getAttribute("data-state"), "todo", "row 0 was not touched");
  await page.waitForFunction(() => /marked seen/i.test(document.getElementById("announce").textContent));
  assert.deepEqual(errors, []);
  await close();
});

test("keyboard-only triage: after s the cursor sits on the successor; inside an expanded group it walks to the next member", async () => {
  const {page, close, errors} = await open("#f=inbox");
  const keys = await rowKeys(page);
  for (const k of "jjj") await page.keyboard.press(k);
  assert.equal(await cursor(page), keys[2]);
  await page.keyboard.press("s");
  await gone(page, keys[2]);
  assert.equal(await cursor(page), keys[3], "the cursor moved to the successor row");
  assert.equal((await focusInfo(page)).tag, "BODY", "keyboard-only: focus never entered the list");
  await page.keyboard.press("j");
  assert.equal(await cursor(page), keys[4]);

  const gov = page.locator(`.row[data-key="${GOV}"]`);
  await gov.locator(".expand").click();                              // click + focus put the cursor on the group row
  await gov.locator(".mrow").first().waitFor();
  const mids = await gov.locator(".mrow").evaluateAll((els) => els.map((e) => e.dataset.mid));
  assert.equal(mids.length, 3);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press("j");
  assert.equal(await cursor(page), mids[0], "j walks into the expanded group");
  await page.keyboard.press("s");
  await page.waitForFunction((id) => !document.querySelector(`.mrow[data-mid="${id}"]`), mids[0]);
  assert.equal((await marksOf(page))[mids[0]].s, "seen");
  assert.equal(await cursor(page), mids[1], "the cursor moved to the next member");
  assert.deepEqual(errors, []);
  await close();
});

test("c collapses and re-expands the cursor's company; j continues past a collapsed company", async () => {
  const {page, close, errors} = await open("#f=inbox");
  const keys = await rowKeys(page);
  const sections = await page.locator("section.company").evaluateAll((els) => els.map((e) => e.dataset.key));
  await page.keyboard.press("j");
  await page.keyboard.press("c");
  assert.equal(await page.locator("section.company.collapsed").count(), 1);
  assert.equal(await page.locator("#list .cur").count(), 0, "a hidden cursor is not drawn");
  await page.keyboard.press("c");
  assert.equal(await page.locator("section.company.collapsed").count(), 0, "c is a toggle");
  assert.equal(await cursor(page), keys[0], "the cursor is back where it was");
  await page.keyboard.press("c");
  await page.keyboard.press("j");
  assert.equal(await page.evaluate(() => document.querySelector("#list .cur").closest("section").dataset.key), sections[1], "j continues into the next company, not from the top");
  assert.deepEqual(errors, []);
  await close();
});

test("n opens an empty note without typing into it; Esc closes the editor even when focus has left it", async () => {
  const {page, close, errors} = await open("#f=inbox");
  const single = (await page.locator(".row").evaluateAll((els) => els.map((e) => !e.dataset.ids.includes(" ")))).indexOf(true);
  for (let i = 0; i <= single; i++) await page.keyboard.press("j");
  await page.keyboard.press("n");
  const ta = page.locator(".noteedit textarea");
  await ta.waitFor();
  assert.equal(await ta.inputValue(), "", "no stray character from the shortcut");
  await page.keyboard.type("call back Tue");
  await page.locator("h1").click();                                   // focus leaves; blur must not collapse the editor (§10.8)
  assert.equal(await page.locator(".noteedit").count(), 1);
  assert.notEqual((await focusInfo(page)).tag, "TEXTAREA");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".noteedit"));
  assert.equal((await focusInfo(page)).act, "note", "focus returns to the row's note button");
  assert.equal(await page.locator(".row").nth(single).locator(".note").innerText(), "call back Tue");
  assert.deepEqual(errors, []);
  await close();
});

test("Esc inside the search debounce clears the query for good", async () => {
  const {page, close} = await open("#f=inbox");
  const n = await page.locator(".row").count();
  await page.locator("#search").focus();
  await page.keyboard.type("zzqx");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  assert.equal(await page.locator("#search").inputValue(), "");
  assert.equal(await page.evaluate(() => location.hash), "#f=inbox");
  assert.equal(await page.locator(".row").count(), n);
  await close();
});

test("the skip link focuses the list without touching the hash or the Back stack; a typed #list is restored to the view", async () => {
  const {page, close} = await open("#f=pipeline&q=e");
  const depth = await page.evaluate(() => history.length);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.className), "skip");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.id === "list");
  assert.equal(await page.evaluate(() => location.hash), "#f=pipeline&q=e", "the click never navigated to #list");
  assert.equal(await page.evaluate(() => history.length), depth, "no duplicate Back entry");
  assert.equal(await page.locator('.tab[aria-current="true"]').getAttribute("data-view"), "pipeline");
  assert.equal(await page.locator("#search").inputValue(), "e");
  assert.notEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("jobwatch.ui.v1") || "{}").view), "inbox", "the persisted view was not reset");

  await page.evaluate(() => { document.activeElement.blur(); location.hash = "#list"; });   // the hashchange fallback for a hand-typed anchor
  await page.waitForFunction(() => document.activeElement?.id === "list" && location.hash === "#f=pipeline&q=e");
  assert.equal(await page.locator('.tab[aria-current="true"]').getAttribute("data-view"), "pipeline");
  await close();
});

test("nothing scrolls under the sticky header: k to an off-screen row, k after a wheel scroll, Shift+Tab through controls", async () => {
  const {page, close} = await open("#f=inbox", {height: 700});
  const n = await page.locator(".row").count();
  assert.ok(n >= 12, `${n} rows`);
  const headerH = await page.locator("header").evaluate((el) => el.offsetHeight);
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--sticky-h")), `${headerH}px`);
  const clearance = () => page.evaluate(() => document.querySelector("#list .cur").getBoundingClientRect().top - document.querySelector("header").getBoundingClientRect().bottom);
  for (let i = 0; i < 12; i++) await page.keyboard.press("j");
  for (let i = 0; i < 6; i++) await page.keyboard.press("k");
  assert.ok((await clearance()) >= 0, `cursor row sits ${await clearance()}px past the header after k`);
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(150);
  await page.keyboard.press("k");
  assert.ok((await clearance()) >= 0, `cursor row sits ${await clearance()}px past the header after wheel + k`);

  await page.locator(".row").nth(11).locator(".star").focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+Tab");
  const gap = await page.evaluate(() => document.activeElement.getBoundingClientRect().top - document.querySelector("header").getBoundingClientRect().bottom);
  assert.ok(gap >= 0, `focused control sits ${gap}px past the header after Shift+Tab`);
  await close();
});

test("Pipeline: a stage change that moves the row to another section keeps focus on its select and the cursor on it", async () => {
  const {page, close, errors} = await open("#f=pipeline");
  const sel = page.locator('section.stage[data-key="applied"] .row select.stagesel').first();
  const key = await sel.evaluate((el) => el.closest(".row").dataset.key);
  await sel.focus();
  await page.keyboard.press("ArrowDown");                            // Applied → OA, the next option
  await page.waitForFunction((k) => document.querySelector(`section.stage[data-key="oa"] .row[data-key="${k}"]:not(.leaving)`), key);
  const f = await focusInfo(page);
  assert.equal(f.select, true, "focus is still on a stage select");
  assert.equal(f.key, key, "…of the same row");
  assert.equal(await cursor(page), key);
  assert.deepEqual(errors, []);
  await close();
});

test("the New-roles banner is left alone by patches that do not change its count", async () => {
  const {page, close} = await open("#f=inbox", {storage: {"jobwatch.lastVisit": "1000"}});
  const banner = page.locator('.banner[data-id="new"]');
  await banner.waitFor();
  await banner.evaluate((el) => {
    window.__bannerMutations = 0;
    new MutationObserver((list) => { window.__bannerMutations += list.length; }).observe(el, {childList: true, subtree: true, characterData: true, attributes: true});
  });
  await page.keyboard.press("j");
  await page.keyboard.press("f");                                     // star: a patch that leaves the New count unchanged
  await page.waitForFunction(() => document.querySelector("#list .cur .star")?.getAttribute("aria-pressed") === "true");
  assert.equal(await page.evaluate(() => window.__bannerMutations), 0, "the live region was not rebuilt");
  await close();
});

test("forced colours: unmarked rows keep the thin border; the cursor row, active tab and pressed chips get an outline", async () => {
  const {page, close} = await open("#f=inbox", {forcedColors: "active"});
  assert.equal(await page.locator('.row[data-state="todo"]').first().evaluate((el) => getComputedStyle(el).borderTopWidth), "1px");
  await page.keyboard.press("j");
  assert.deepEqual(await page.locator(".row.cur").evaluate((el) => [getComputedStyle(el).outlineStyle, getComputedStyle(el).outlineWidth]), ["solid", "3px"]);
  assert.equal(await page.locator('.tab[aria-current="true"]').evaluate((el) => getComputedStyle(el).outlineStyle), "solid");
  await page.keyboard.press("1");
  await page.waitForFunction(() => document.querySelector('.chip[data-cat="SWE"]').getAttribute("aria-pressed") === "true");
  assert.equal(await page.locator('.chip[aria-pressed="true"]').evaluate((el) => getComputedStyle(el).outlineStyle), "solid");
  assert.equal(await page.locator('.chip[aria-pressed="false"]').first().evaluate((el) => getComputedStyle(el).outlineStyle), "none");
  await close();
});

test("roles.json unreadable: the error box shows in every view and the counts stay blank — tabs, More menu, sticky bar, phone sheet and the New banner — even with manual roles", async () => {
  const role = manual[0];
  const fresh = {...role, id: "manual:fresh", title: "Applied Scientist - 2026 (US)", added: Math.floor(Date.now() / 1000)};   // unmarked and inside the 36 h floor: New would count it from manual roles alone
  const extra = await serveCopy({"status.json": {[role.id]: {s: "applied", t: 1788240800, h: [{s: "applied", t: 1788240800}]}}, "companies.json": companies, "manual.json": [role, fresh], "meta.json": freshMeta()});
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  try {
    const page = await context.newPage();
    const {errors} = watch(page, extra.url);
    await page.goto(`${extra.url}index.html#f=inbox`, {waitUntil: "networkidle"});
    await page.waitForSelector('.banner[data-id="roles-error"]');
    assert.match(await page.locator(".empty .big").innerText(), /Couldn't load roles\.json/);
    assert.equal(await page.locator(".row").count(), 0, "the manual roles are not painted over the error");
    assert.equal(await page.locator('.banner[data-id="new"]').count(), 0, "no New banner counted from manual roles alone");
    const banners = await page.locator("#banners .banner").evaluateAll((els) => els.map((e) => [e.dataset.id, e.textContent]));
    assert.ok(banners.every(([id, text]) => id === "roles-error" || !/\d/.test(text)), `only the roles-error banner may carry a number: ${JSON.stringify(banners)}`);
    assert.deepEqual(new Set(await page.locator("[data-count]").evaluateAll((els) => els.map((e) => e.textContent))), new Set(["–"]), "blank tab counts");
    assert.equal(await page.locator("#sbViewCount").evaluate((el) => el.textContent), "–");
    assert.ok((await page.locator("#moreViews option").evaluateAll((els) => els.map((o) => o.textContent))).every((t) => !/\d/.test(t)), "no numbers in the More menu");
    await page.locator('.tab[data-view="pipeline"]').click();
    assert.match(await page.locator(".empty .big").innerText(), /Couldn't load roles\.json/, "the error wins in Pipeline too");
    assert.equal(await page.locator(".row").count(), 0);

    await page.setViewportSize({width: 375, height: 667});             // phone: the Views sheet must agree with the sticky bar above it
    await page.locator("#sbView").click();
    await page.locator("#dlgViews").waitFor({state: "visible"});
    assert.equal(await page.locator("#viewsList li").count(), 14);
    assert.deepEqual(new Set(await page.locator("#viewsList .n").evaluateAll((els) => els.map((e) => e.textContent))), new Set(["–"]), "blank counts in the sheet");
    assert.ok(!/\d/.test(await page.locator("#viewsList").innerText()), "no numbers anywhere in the sheet");
    assert.ok(!errors.some((e) => e.startsWith("pageerror")), errors.join("\n"));
  } finally {
    await context.close();
    extra.stop();
  }
});

test("stale-scan banner links to the Actions tab from meta.repo; a company name with control characters survives mark + undo", async () => {
  const weird = {...roles[0], id: "weird:1", company: "Weird\nCo\fInc", title: "Software Engineer, New Grad"};
  delete weird.group;
  const staleS = Math.floor(Date.now() / 1000) - 28 * 3600;
  const extra = await serveCopy({"roles.json": [...roles, weird], "status.json": status, "companies.json": companies, "manual.json": [], "meta.json": freshMeta({last_run: staleS, last_change: staleS})});
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  try {
    const page = await context.newPage();
    const {errors} = watch(page, extra.url);
    await page.goto(`${extra.url}index.html#f=inbox`, {waitUntil: "networkidle"});
    await page.waitForSelector(".row");
    const link = page.locator('.banner[data-id="stale-scan"] a');
    await link.waitFor();
    assert.equal(await link.innerText(), "Open Actions");
    assert.equal(await link.getAttribute("href"), "https://github.com/owner/jobwatch/actions");
    assert.match(await page.locator('.banner[data-id="stale-scan"] p').innerText(), /hasn't scanned in 28 h/);

    const sel = '.row[data-id="weird:1"]';
    await page.locator(sel).locator('.qbtn[data-s="seen"]').click();
    await page.waitForFunction((s) => !document.querySelector(`${s}:not(.leaving)`), sel);
    await page.keyboard.press("u");
    await page.waitForSelector(`${sel}:not(.leaving)`);
    assert.equal(await page.locator(`${sel}:not(.leaving)`).evaluate((el) => el.closest("section").dataset.key), "Weird\nCo\fInc", "re-inserted into its own company section");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    extra.stop();
  }
});
