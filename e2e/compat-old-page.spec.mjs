// compat-old-page (§12.3, hazard 1): the CURRENT tracker (tests/fixtures/real/index.v1.html) served against v2 data —
// roles.json with the additive fields and HW rows, status.json with t/h/d — must render, sort HW last and show
// readable dates.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {serveCopy, launch, watch, readJson, realFile, FIXTURES} from "./helpers.mjs";

const roles = readJson(`${FIXTURES}/roles.json`);
let srv;
let browser;

before(async () => {
  const v1 = realFile("index.v1.html");
  assert.ok(v1, "tests/fixtures/real/index.v1.html is required");
  srv = await serveCopy({"index.html": v1, "roles.json": roles, "status.json": readJson(`${FIXTURES}/status.json`), "companies.json": readJson(`${FIXTURES}/companies.json`), "manual.json": readJson(`${FIXTURES}/manual.json`), "meta.json": readJson(`${FIXTURES}/meta.json`)});
  browser = await launch();
});
after(async () => {
  await browser?.close();
  srv?.stop();
});

test("v1 page renders v2 roles.json: HW sorts last, dates are readable, no errors", async () => {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  const {errors, external} = watch(page, srv.url);
  await page.goto(`${srv.url}index.html`, {waitUntil: "networkidle"});
  await page.waitForSelector(".row");
  const active = roles.filter((r) => r.active !== false).length;
  assert.equal(await page.locator(".row").count(), active, "one v1 row per active role");
  const appleTags = await page.locator("section.group").filter({has: page.locator("h2", {hasText: /^Apple/})}).locator(".row .meta .tag").allInnerTexts();
  assert.ok(appleTags.length >= 2 && /HW/.test(appleTags[appleTags.length - 1]) && !/HW/.test(appleTags[0]), `HW sorts last within Apple: ${appleTags.join(" | ")}`);
  const metas = await page.locator(".row .meta").allInnerTexts();
  assert.ok(metas.every((m) => /\b20\d\d-\d\d-\d\d\b/.test(m) || /added by you/.test(m)), "posted is an absolute date the old page prints verbatim");
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  await page.close();
});
