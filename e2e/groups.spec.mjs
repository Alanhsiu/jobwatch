// groups (§12.3, §10.7): 3 postings fold into one row ×3; Dismiss on the row writes 3 marks; Applied with 2 todo
// members expands and asks which posting; "apply to all" fans out; Undo restores every touched id. Company-level
// actions (Seen all / Dismiss all…) hand focus on instead of dropping it to <body>, and Undo brings the plain
// buttons back, never a stale confirm.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {serveCopy, launch, watch, readJson, freshMeta, FIXTURES} from "./helpers.mjs";
import {groupKey} from "../assets/lib.js";

const roles = readJson(`${FIXTURES}/roles.json`);
const status = readJson(`${FIXTURES}/status.json`);
const GOV = groupKey("TikTok", "Machine Learning Engineer Graduate - E-Commerce Governance");
const RISK = groupKey("ByteDance", "Machine Learning Engineer Graduate - E-Commerce Risk Control");
const govIds = roles.filter((r) => r.group === GOV).map((r) => r.id);
const riskTodo = roles.filter((r) => r.group === RISK && !status[r.id]).map((r) => r.id);
let srv;
let browser;

before(async () => {
  assert.equal(govIds.length, 3);
  assert.equal(riskTodo.length, 2);
  srv = await serveCopy({"roles.json": roles, "status.json": status, "companies.json": [], "manual.json": [], "meta.json": freshMeta()});
  browser = await launch();
});
after(async () => {
  await browser?.close();
  srv?.stop();
});

const marksOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("jobwatch.marks.v3") || "{}"));
const cssq = (s) => s.replace(/"/g, '\\"');
const rowSel = (key) => `.row[data-key="${cssq(key)}"]:not(.leaving)`;
const secSel = (key) => `section.company[data-key="${cssq(key)}"]`;
const focusInfo = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return {tag: a.tagName, act: a.dataset.act ?? null, view: a.dataset.view ?? null, section: a.closest("section")?.dataset.key ?? null, inRow: !!a.closest(".row"), collapsed: !!a.closest("section.collapsed"), visible: a.checkVisibility()};
});

/** A fresh context per test (its own marks and collapse state). */
async function open(hash = "#f=inbox", contextOpts = {}) {
  const context = await browser.newContext({viewport: {width: 1280, height: 900}, ...contextOpts});
  const page = await context.newPage();
  const watcher = watch(page, srv.url);
  await page.goto(`${srv.url}index.html${hash}`, {waitUntil: "networkidle"});
  await page.waitForSelector(".row");
  return {page, close: () => context.close(), ...watcher};
}

test("three postings fold into one row; Dismiss marks all three; Undo restores them", async () => {
  const {page, close, errors} = await open();
  const row = page.locator(rowSel(GOV));
  assert.equal(await row.count(), 1);
  assert.equal(await row.locator(".body .n").first().innerText(), "×3");
  assert.equal(await row.locator(".mchip").count(), 3);
  assert.equal((await row.getAttribute("data-ids")).split(" ").length, 3);

  await row.locator('.qbtn[data-s="dropped"]').click();
  await page.waitForFunction((sel) => !document.querySelector(sel), rowSel(GOV));
  let marks = await marksOf(page);
  for (const id of govIds) assert.equal(marks[id]?.s, "dropped", `${id} dismissed`);
  assert.match(await page.locator("#toast").innerText(), /Dismissed 3 of 3 postings/);

  await page.locator("#toast button").click();
  await page.waitForSelector(rowSel(GOV));
  marks = await marksOf(page);
  for (const id of govIds) assert.equal(marks[id]?.s, undefined, `${id} back to todo after undo`);
  assert.equal(await page.locator(rowSel(GOV)).locator(".body .n").first().innerText(), "×3");
  assert.deepEqual(errors, []);
  await close();
});

test("Applied with two todo members asks which posting; picking one marks only it", async () => {
  const {page, close, errors} = await open();
  const row = page.locator(rowSel(RISK));
  assert.equal(await row.locator(".body .n").first().innerText(), "×2", "the applied member is not in Inbox");
  await row.locator('.qbtn[data-s="applied"]').click();
  await row.locator(".gmembers .ask").waitFor();
  assert.match(await row.locator(".ask").innerText(), /Which posting did you apply to\?/);
  assert.equal(await row.locator(".mrow .qbtn.pick").count(), 2);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("pick")), true, "focus moves to the first choice");
  let marks = await marksOf(page);
  for (const id of riskTodo) assert.equal(marks[id], undefined, "nothing written until a posting is chosen");

  const picked = await row.locator(".mrow").first().getAttribute("data-mid");
  await row.locator(".mrow .qbtn.pick").first().click();
  await page.waitForFunction((id) => JSON.parse(localStorage.getItem("jobwatch.marks.v3") || "{}")[id]?.s === "applied", picked);
  marks = await marksOf(page);
  const other = riskTodo.find((id) => id !== picked);
  assert.equal(marks[other], undefined, "the sibling stays todo");
  const remaining = page.locator(rowSel(RISK));
  assert.equal(await remaining.count(), 1, "the sibling still shows in Inbox as a plain row");
  assert.equal(await remaining.locator(".body .n").count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test("apply to all fans out; Undo restores every touched id in one step", async () => {
  const {page, close, errors} = await open();
  const row = page.locator(rowSel(GOV));
  await row.locator('.qbtn[data-s="applied"]').click();
  await row.locator(".ask").waitFor();
  await row.locator('[data-act="askall"]').click();
  await page.waitForFunction((sel) => !document.querySelector(sel), rowSel(GOV));
  let marks = await marksOf(page);
  for (const id of govIds) assert.equal(marks[id]?.s, "applied");
  await page.keyboard.press("u");
  await page.waitForSelector(rowSel(GOV));
  marks = await marksOf(page);
  for (const id of govIds) assert.ok(!marks[id] || (!marks[id].s && Number.isInteger(marks[id].d)), `${id} restored to todo (tombstone)`);
  assert.deepEqual(errors, []);
  await close();
});

test("Dismiss all → confirm → Undo brings Seen all / Dismiss all… back, never the stale confirm", async () => {
  const {page, close, errors} = await open("#f=all");
  const sec = page.locator("section.company").filter({has: page.locator(".coacts:not([hidden])")}).first();
  const key = await sec.getAttribute("data-key");
  await sec.locator('[data-act="codismiss"]').click();
  assert.match(await sec.locator(".coacts .confirm").innerText(), /^Dismiss \d+ roles at /);
  await sec.locator('[data-act="codismiss-yes"]').click();
  await page.waitForFunction((s) => document.querySelector(`${s} .coacts`)?.hidden === true, secSel(key));
  assert.match(await page.locator("#toast").innerText(), /Dismissed \d+ roles at /);
  assert.deepEqual((await focusInfo(page)).act, "cotoggle", "focus parks on the company toggle while its actions are hidden");

  await page.locator("#toast button").click();                       // Undo: the rows return to review
  await page.waitForFunction((s) => document.querySelector(`${s} .coacts`)?.hidden === false, secSel(key));
  const acts = sec.locator(".coacts");
  assert.equal(await acts.locator('[data-act="codismiss-yes"]').count(), 0, "no stale confirm");
  assert.equal(await acts.locator('[data-act="coseen"]').count(), 1);
  assert.equal(await acts.locator('[data-act="codismiss"]').count(), 1);
  assert.deepEqual(errors, []);
  await close();
});

for (const reducedMotion of ["no-preference", "reduce"]) {
  test(`Seen all, Dismiss all and marking the last row of a search never drop focus to <body> (reduced motion: ${reducedMotion})`, async () => {
    const {page, close, errors} = await open("#f=inbox", {reducedMotion});
    const sections = await page.locator("section.company").evaluateAll((els) => els.map((e) => e.dataset.key));
    assert.ok(sections.length >= 3);
    await page.locator(secSel(sections[0])).locator('[data-act="coseen"]').focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction((s) => !document.querySelector(`${s}:not(.leaving)`), secSel(sections[0]));
    await page.waitForTimeout(250);                                  // past the 150 ms fade
    let f = await focusInfo(page);
    assert.notEqual(f.tag, "BODY", "focus did not fall to <body> after Seen all");
    assert.equal(f.section, sections[1], "focus moved to the next company's first row");
    assert.equal(f.inRow, true);

    await page.locator(secSel(sections[1])).locator('[data-act="codismiss"]').focus();
    await page.keyboard.press("Enter");
    assert.equal((await focusInfo(page)).act, "codismiss-yes", "the inline confirm takes focus");
    await page.keyboard.press("Enter");
    await page.waitForFunction((s) => !document.querySelector(`${s}:not(.leaving)`), secSel(sections[1]));
    await page.waitForTimeout(250);
    f = await focusInfo(page);
    assert.notEqual(f.tag, "BODY", "focus did not fall to <body> after Dismiss all");
    assert.equal(f.section, sections[2]);

    const lone = roles.filter((r) => r.active && !status[r.id] && !sections.slice(0, 2).includes(r.company) && roles.filter((o) => o.title === r.title).length === 1)
      .sort((a, b) => b.title.length - a.title.length)[0];
    await page.goto(`${srv.url}index.html#f=inbox&q=${encodeURIComponent(lone.title)}`, {waitUntil: "networkidle"});
    await page.waitForSelector(".row");
    assert.equal(await page.locator(".row").count(), 1, `the search isolates ${lone.title}`);
    await page.locator('.row .qbtn[data-s="applied"]').focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".empty");
    assert.equal((await focusInfo(page)).view, "inbox", "with no rows left, focus goes to the active tab");
    assert.deepEqual(errors, []);
    await close();
  });
}

test("marking the last row before a collapsed company hands focus to a visible row", async () => {
  const {page, close, errors} = await open();
  const sections = page.locator("section.company");
  await sections.nth(1).locator(".cotoggle").click();
  assert.equal(await sections.nth(1).evaluate((el) => el.classList.contains("collapsed")), true);
  const last = sections.nth(0).locator(".row").last();
  const key = await last.getAttribute("data-key");
  await last.locator('.qbtn[data-s="seen"]').click();
  await page.waitForFunction((sel) => !document.querySelector(sel), rowSel(key));
  await page.waitForTimeout(250);
  const f = await focusInfo(page);
  assert.notEqual(f.tag, "BODY");
  assert.equal(f.inRow, true, "focus is on a row control");
  assert.equal(f.collapsed, false, "…not one hidden inside the collapsed company");
  assert.equal(f.visible, true);
  assert.deepEqual(errors, []);
  await close();
});
