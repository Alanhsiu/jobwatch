// mobile (§10.11 acceptance): no horizontal overflow at 320/360/375/390/430 px; at 375×667 the sticky bar is ≤ 56 px,
// ≥ 4 Inbox rows fit below it once the header has scrolled away, every control — dialog fields, the note editor and
// group prompts included — is ≥ 16 px (no iOS auto-zoom), the toast is a wide block rather than a narrow column, and
// Shift+Tab never parks the focused control under the sticky bar.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {serveCopy, launch, watch, readJson, freshMeta, FIXTURES} from "./helpers.mjs";
import {groupKey} from "../assets/lib.js";

const RISK = groupKey("ByteDance", "Machine Learning Engineer Graduate - E-Commerce Risk Control");   // two todo members → "Which posting?"
let srv;
let browser;

before(async () => {
  srv = await serveCopy({"roles.json": readJson(`${FIXTURES}/roles.json`), "status.json": readJson(`${FIXTURES}/status.json`), "companies.json": readJson(`${FIXTURES}/companies.json`), "manual.json": readJson(`${FIXTURES}/manual.json`), "meta.json": freshMeta()});
  browser = await launch();
});
after(async () => {
  await browser?.close();
  srv?.stop();
});

async function open(width, height = 667, hash = "#f=inbox") {
  const context = await browser.newContext({viewport: {width, height}, isMobile: true, hasTouch: true, deviceScaleFactor: 2});
  const page = await context.newPage();
  const watcher = watch(page, srv.url);
  await page.goto(`${srv.url}index.html${hash}`, {waitUntil: "networkidle"});
  await page.waitForSelector(".row");
  return {page, context, ...watcher};
}

/** Visible controls under `scope` whose font is below 16 px (empty when the iOS auto-zoom rule holds). */
const smallControls = (page, scope) => page.evaluate((s) => [...document.querySelectorAll(`${s} input, ${s} select, ${s} textarea, ${s} button`)]
  .filter((el) => el.checkVisibility() && parseFloat(getComputedStyle(el).fontSize) < 16)
  .map((el) => `${el.tagName}#${el.id}.${el.className}:${getComputedStyle(el).fontSize}`).slice(0, 8), scope);

for (const width of [320, 360, 375, 390, 430]) {
  test(`no horizontal overflow at ${width}px`, async () => {
    const {page, context, errors} = await open(width);
    const [scrollW, clientW] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.equal(scrollW, clientW, `scrollWidth ${scrollW} vs clientWidth ${clientW}`);
    const wide = await page.evaluate((w) => [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > w + 0.5 && getComputedStyle(el).position !== "fixed").map((el) => `${el.tagName}.${el.className}`).slice(0, 5), width);
    assert.deepEqual(wide, [], "no element extends past the viewport");
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test("375×667: sticky bar ≤ 56 px, ≥ 4 rows visible below it, controls ≥ 16 px", async () => {
  const {page, context} = await open(375);
  const bar = page.locator(".stickybar");
  const barBox = await bar.boundingBox();
  assert.ok(barBox.height <= 56, `sticky bar is ${barBox.height}px`);
  await page.evaluate(() => {                                            // header scrolled away: first row sits under the bar
    const first = document.querySelector(".row");
    window.scrollTo(0, first.getBoundingClientRect().top + window.scrollY - document.querySelector(".stickybar").offsetHeight);
  });
  await page.waitForTimeout(150);
  const stuck = await bar.boundingBox();
  assert.ok(Math.abs(stuck.y) < 1, `sticky bar sits at the top after scrolling (y=${stuck.y})`);
  const fullyVisible = await page.evaluate(() => {
    const barH = document.querySelector(".stickybar").offsetHeight;
    return [...document.querySelectorAll(".row")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= barH - 0.5 && r.bottom <= window.innerHeight + 0.5;
    }).length;
  });
  assert.ok(fullyVisible >= 4, `${fullyVisible} rows fully visible`);
  assert.deepEqual(await smallControls(page, "body"), [], "every visible control is at least 16px");
  assert.equal(await page.locator("header").evaluate((el) => getComputedStyle(el).position), "static");
  const quick = await page.locator(".row .qbtn").first().boundingBox();
  assert.ok(quick.width >= 44 && quick.height >= 36, `quick button ${quick.width}×${quick.height}`);
  await context.close();
});

test("375×667: dialog fields, the note editor and the group prompt are ≥ 16 px too", async () => {
  const {page, context, errors} = await open(375);
  for (const id of ["dlgCompanies", "dlgAddRole", "dlgSettings", "dlgSync"]) {
    await page.evaluate((d) => {
      document.getElementById(d).showModal();
      if (d === "dlgSettings") document.getElementById("quietFields").hidden = false;   // the quiet-hours number/text fields
    }, id);
    assert.deepEqual(await smallControls(page, `#${id}`), [], `${id}: every control is at least 16px`);
    await page.evaluate((d) => document.getElementById(d).close(), id);
  }
  await page.locator(".row .notebtn").first().click();
  const ta = page.locator(".noteedit textarea");
  await ta.waitFor();
  assert.ok(parseFloat(await ta.evaluate((el) => getComputedStyle(el).fontSize)) >= 16, "note editor textarea");
  await page.keyboard.press("Escape");
  const risk = page.locator(`.row[data-key="${RISK}"]`);
  await risk.locator('.qbtn[data-s="applied"]').click();
  await risk.locator(".ask .linkbtn").first().waitFor();
  assert.deepEqual(await smallControls(page, ".gmembers"), [], "group prompt controls");
  assert.deepEqual(errors, []);
  await context.close();
});

test("375×667: the undo toast is a wide block, not a narrow column", async () => {
  const {page, context} = await open(375);
  await page.locator('.row .qbtn[data-s="seen"]').first().click();
  const toast = page.locator("#toast");
  await toast.waitFor();
  const box = await toast.boundingBox();
  assert.ok(box.width >= 300, `toast is ${box.width}px wide`);
  assert.ok(box.height <= 90, `toast is ${box.height}px tall`);
  assert.ok(box.x >= 0 && box.x + box.width <= 375, "toast stays inside the viewport");
  await context.close();
});

test("375×667: --sticky-h is the bar's height and Shift+Tab never hides the focused control under it", async () => {
  const {page, context} = await open(375);
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--sticky-h")), "48px");
  const n = await page.locator(".row").count();
  await page.locator(".row").nth(Math.min(8, n - 1)).locator(".star").focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press("Shift+Tab");
  const gap = await page.evaluate(() => document.activeElement.getBoundingClientRect().top - document.querySelector(".stickybar").getBoundingClientRect().bottom);
  assert.ok(gap >= 0, `focused control sits ${gap}px past the sticky bar`);
  await context.close();
});

test("375×667: the view sheet lists every view with counts and switches views", async () => {
  const {page, context, errors} = await open(375);
  await page.locator("#sbView").click();
  const sheet = page.locator("#dlgViews");
  await sheet.waitFor({state: "visible"});
  assert.equal(await sheet.locator("li button").count(), 14);
  assert.match(await sheet.locator('li button[data-v="inbox"]').innerText(), /Inbox\s+\d+/);
  await sheet.locator('li button[data-v="pipeline"]').click();
  await page.waitForFunction(() => location.hash.includes("f=pipeline"));
  assert.equal(await page.locator("#sbViewName").innerText(), "Pipeline");
  assert.deepEqual(errors, []);
  await context.close();
});
