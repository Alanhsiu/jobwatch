// compat-new-page-old-data (§12.3, hazard 3): the v2 page against the real v1 state files with no meta.json —
// groups are computed client-side, the scan pill says "scan time unknown", legacy marks render, no errors.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {serveCopy, launch, watch, realFile} from "./helpers.mjs";
import {groupKey} from "../assets/lib.js";

let srv;
let browser;
const roles = JSON.parse(realFile("roles.json"));
const status = JSON.parse(realFile("status.json"));

before(async () => {
  srv = await serveCopy({"roles.json": realFile("roles.json"), "status.json": realFile("status.json"), "companies.json": realFile("companies.json"), "manual.json": realFile("manual.json")});
  browser = await launch();
});
after(async () => {
  await browser?.close();
  srv?.stop();
});

test("new page + old data: groups computed, scan time unknown, legacy marks shown", async () => {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  const {errors, external} = watch(page, srv.url);
  await page.goto(`${srv.url}index.html#f=inbox`, {waitUntil: "networkidle"});
  await page.waitForSelector(".row");
  assert.equal(await page.locator("#scanText").innerText(), "scan time unknown");
  assert.equal(await page.locator("#syncText").innerText(), "Local only");

  const inboxIds = new Set(roles.filter((r) => r.active && !status[r.id]).map((r) => r.id));
  const groups = new Map();
  for (const r of roles) if (inboxIds.has(r.id)) groups.set(groupKey(r.company, r.title), (groups.get(groupKey(r.company, r.title)) || 0) + 1);
  assert.equal(await page.locator(".row").count(), groups.size, "one row per computed group");
  const multi = [...groups].find(([, n]) => n >= 3);
  assert.ok(multi, "the real data has a 3+ member group");
  const row = page.locator(`.row[data-key="${multi[0].replace(/"/g, '\\"')}"]`);
  assert.equal(await row.locator(".body .n").first().innerText(), `×${multi[1]}`);
  assert.equal(await row.locator(".mchip").count(), multi[1]);

  await page.goto(`${srv.url}index.html#f=pipeline`, {waitUntil: "networkidle"});
  await page.waitForSelector(".row");
  const applied = Object.values(status).filter((e) => e.s === "applied").length;
  assert.ok(applied > 0);
  const stageLines = await page.locator(".row .stageline").allInnerTexts();
  assert.ok(stageLines.length > 0 && stageLines.every((t) => /date unknown/.test(t)), "legacy marks have no t: the page says so instead of inventing one");
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  await page.close();
});
