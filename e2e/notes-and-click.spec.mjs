// notes-and-click (§12.3, audits 003/047/084): typing a note across a push keeps focus and every keystroke; with a
// note editor open, the first click on another row's Applied button lands.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {serveCopy, launch, watch, seedStorage, readJson, freshMeta, FIXTURES} from "./helpers.mjs";
import {installGitHubMock} from "./ghmock.mjs";

const roles = readJson(`${FIXTURES}/roles.json`);
let srv;
let browser;

before(async () => {
  srv = await serveCopy({"roles.json": roles, "status.json": {}, "companies.json": [], "manual.json": [], "meta.json": freshMeta()});
  browser = await launch();
});
after(async () => {
  await browser?.close();
  srv?.stop();
});

test("typing 40 chars across pushes keeps focus and text; a click elsewhere lands first time", async () => {
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  const page = await context.newPage();
  const {errors} = watch(page, srv.url);
  await seedStorage(page, {"jobwatch.gh.repo": "owner/jobwatch", "jobwatch.gh.pat": "github_pat_test"});
  const gh = await installGitHubMock(page, {"status.json": {}, "companies.json": [], "manual.json": [], "roles.json": roles, "meta.json": freshMeta()}, {latency: {PUT: 700}});
  await page.goto(`${srv.url}index.html#f=inbox`, {waitUntil: "networkidle"});
  await page.waitForSelector(".row");
  await page.waitForFunction(() => /^Synced/.test(document.getElementById("syncText").textContent));

  const rowA = page.locator(".row").nth(0);
  const rowB = page.locator(".row").nth(1);
  const idA = await rowA.getAttribute("data-id");
  const idB = await rowB.getAttribute("data-id");
  const keyB = await rowB.getAttribute("data-key");
  await rowA.locator('[data-act="note"]').click();
  const ta = rowA.locator(".noteedit textarea");
  await ta.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");

  const text = "Recruiter Jane Doe: OA due Friday 5pm PT";       // 40 chars
  assert.equal(text.length, 40);
  await page.keyboard.type(text.slice(0, 12), {delay: 60});
  await page.waitForTimeout(3200);                              // idle commit (2 s) + push (GET + 700 ms PUT) happen here
  await page.keyboard.type(text.slice(12, 26), {delay: 60});
  await page.waitForTimeout(3200);                              // a second push while the editor stays open
  await page.keyboard.type(text.slice(26), {delay: 60});
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA", "focus never left the editor");
  assert.equal(await ta.inputValue(), text, "no keystroke was lost");
  assert.equal(await rowA.locator(".noteedit").count(), 1, "the editor never collapsed");
  assert.equal(await rowA.locator(".note").innerText(), text, "the preview follows the draft live");

  await rowB.locator('.qbtn[data-s="applied"]').click();          // ONE click while A's editor has focus
  await page.waitForFunction((k) => !document.querySelector(`.row[data-key="${k}"]:not(.leaving)`), keyB);
  const marks = await page.evaluate(() => JSON.parse(localStorage.getItem("jobwatch.marks.v3")));
  assert.equal(marks[idB].s, "applied", "B was marked on the first click");
  assert.equal(await rowA.locator(".noteedit").count(), 1, "blur did not collapse A's editor");

  await ta.focus();
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => !document.querySelector(".noteedit"));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("jobwatch.dirty.v1") || "[]").length === 0, null, {timeout: 15000});
  assert.equal(gh.json("status.json")[idA].note, text);
  assert.equal(gh.json("status.json")[idB].s, "applied");
  assert.equal(await rowA.locator('[data-act="note"]').innerText(), "edit note");
  assert.deepEqual(errors, []);
  await context.close();
});
