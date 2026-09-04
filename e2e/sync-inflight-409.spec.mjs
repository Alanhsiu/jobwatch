// sync-inflight-409 (§12.3, audits 013/016/078): a second edit during a slow PUT must survive (value snapshot), and
// one injected stale-sha 409 must be absorbed by re-GET/re-PUT with no error state.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {serveCopy, launch, watch, seedStorage, readJson, freshMeta, FIXTURES} from "./helpers.mjs";
import {installGitHubMock} from "./ghmock.mjs";

const roles = readJson(`${FIXTURES}/roles.json`);
let srv;
let browser;

before(async () => {
  srv = await serveCopy({"roles.json": roles, "status.json": {}, "companies.json": readJson(`${FIXTURES}/companies.json`), "manual.json": readJson(`${FIXTURES}/manual.json`), "meta.json": freshMeta()});
  browser = await launch();
});
after(async () => {
  await browser?.close();
  srv?.stop();
});

test("edit during an in-flight PUT wins, and a 409 is retried silently", async () => {
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  const page = await context.newPage();
  const {errors} = watch(page, srv.url);
  await seedStorage(page, {"jobwatch.gh.repo": "owner/jobwatch", "jobwatch.gh.pat": "github_pat_test"});
  const gh = await installGitHubMock(page, {
    "status.json": {}, "companies.json": readJson(`${FIXTURES}/companies.json`), "manual.json": readJson(`${FIXTURES}/manual.json`),
    "roles.json": roles, "meta.json": freshMeta(),
  }, {latency: {PUT: 1500}, requireAuth: true});
  await page.goto(`${srv.url}index.html#f=all`, {waitUntil: "networkidle"});
  await page.waitForSelector(".row");
  await page.waitForFunction(() => /^Synced/.test(document.getElementById("syncText").textContent));

  const row = page.locator(".row").first();
  const id = await row.getAttribute("data-id");
  await row.locator("select.stagesel").selectOption("applied");             // t=0: push debounced to t≈2 s, PUT until ≈3.6 s
  await page.waitForFunction(() => document.getElementById("syncText").textContent === "Syncing…");
  await page.waitForTimeout(600);                                          // PUT #1 is in flight now
  gh.state.staleShaOnce = true;                                             // the next PUT (the second push) hits a stale sha once
  await row.locator("select.stagesel").selectOption("oa");                  // edit while PUT #1 is in flight
  await page.waitForFunction(() => /^Synced/.test(document.getElementById("syncText").textContent) && !document.querySelector('.banner[data-id="sync-err"]'), null, {timeout: 20000});
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("jobwatch.dirty.v1") || "[]").length === 0, null, {timeout: 20000});

  assert.equal(gh.json("status.json")[id].s, "oa", "remote holds the later edit");
  const local = await page.evaluate(() => JSON.parse(localStorage.getItem("jobwatch.marks.v3")));
  assert.equal(local[id].s, "oa");
  assert.deepEqual(local[id].h.map((h) => h.s), ["applied", "oa"]);
  const puts = gh.puts("status.json").map((p) => p.status);
  assert.ok(puts.includes(409), `one PUT was refused with 409: ${puts.join(",")}`);
  assert.ok(puts.filter((s) => s === 200 || s === 201).length >= 2, `both edits were written: ${puts.join(",")}`);
  assert.equal(await page.locator('.banner[data-id="sync-err"]').count(), 0, "no error chip after the transient 409");
  assert.equal(await row.locator("select.stagesel").inputValue(), "oa");
  assert.deepEqual(errors, []);
  await context.close();
});
