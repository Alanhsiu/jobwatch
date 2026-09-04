// companies (§10.15): the Companies dialog keeps keyboard focus inside the chip list when it is rebuilt, keeps a save
// confirmation in front of the scan progress that follows it, clears the input only after a successful save, and
// shows its actions and status line above the chip cloud. The + Role dialog (same list-editing path, manual.json)
// splits locations on semicolons so "Taipei, Taiwan" stays one place.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {serveCopy, launch, watch, seedStorage, readJson, freshMeta, FIXTURES} from "./helpers.mjs";
import {installGitHubMock} from "./ghmock.mjs";
import {norm} from "../assets/lib.js";

const roles = readJson(`${FIXTURES}/roles.json`);
const companies = readJson(`${FIXTURES}/companies.json`);
const manual = readJson(`${FIXTURES}/manual.json`);
const meta = freshMeta();
let srv;
let browser;

before(async () => {
  srv = await serveCopy({"roles.json": roles, "status.json": {}, "companies.json": companies, "manual.json": [], "meta.json": meta});
  browser = await launch();
});
after(async () => {
  await browser?.close();
  srv?.stop();
});

/** A synced page (PAT + GitHub mock whose repo holds `files` over the defaults), rows rendered. */
async function openSynced(files = {}) {
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  const page = await context.newPage();
  const watcher = watch(page, srv.url);
  await seedStorage(page, {"jobwatch.gh.repo": "owner/jobwatch", "jobwatch.gh.pat": "github_pat_test"});
  const gh = await installGitHubMock(page, {"status.json": {}, "companies.json": companies, "manual.json": [], "roles.json": roles, "meta.json": meta, ...files});
  await page.goto(`${srv.url}index.html#f=inbox`, {waitUntil: "networkidle"});
  await page.waitForSelector(".row");
  await page.waitForFunction(() => /^Synced/.test(document.getElementById("syncText").textContent));
  return {page, gh, close: () => context.close(), ...watcher};
}

/** The Companies dialog open with its chips rendered. */
async function openDialog() {
  const opened = await openSynced();
  await opened.page.locator("#btnCompanies").click();
  await opened.page.locator("#coChips .kw").first().waitFor();
  return opened;
}

/** The + Role dialog open and editable: the fixture's hand-added row proves manual.json arrived through the API. */
async function openAddRole() {
  const opened = await openSynced({"manual.json": manual});
  await opened.page.waitForSelector(`.row[data-id="${manual[0].id}"]`);
  await opened.page.locator("#btnAddRole").click();
  await opened.page.waitForSelector("#mAdd:enabled");
  return opened;
}

const focusedChip = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return {inChips: !!a.closest("#coChips"), kw: a.closest(".kw")?.dataset.kw ?? null, remove: a.matches("[data-kwx]")};
});

test("removing a keyword keeps focus in the chip list; Cancel on the inline confirm returns to that keyword's ×", async () => {
  const {page, gh, close, errors} = await openDialog();
  const kws = await page.locator("#coChips .kw").evaluateAll((els) => els.map((e) => e.dataset.kw));
  const i = kws.indexOf("adobe");
  assert.ok(i >= 0 && i < kws.length - 1);
  await page.locator('#coChips .kw[data-kw="adobe"] [data-kwx]').click();          // 0 roles: removed without a confirm
  await page.waitForFunction(() => !document.querySelector('#coChips .kw[data-kw="adobe"]'));
  assert.deepEqual(await focusedChip(page), {inChips: true, kw: kws[i + 1], remove: false}, "focus lands on the keyword that took adobe's place");
  assert.equal(gh.json("companies.json").includes("adobe"), false);
  await page.waitForFunction(() => /^Removed ‘adobe’/.test(document.getElementById("coMsg").textContent));

  await page.locator('#coChips .kw[data-kw="tiktok"] [data-kwx]').click();         // 12 active roles: inline confirm
  assert.match(await page.locator('#coChips .kw[data-kw="tiktok"] .confirm').innerText(), /Removing ‘tiktok’ hides 12 roles/);
  await page.locator('#coChips .kw[data-kw="tiktok"] [data-kwno]').click();
  assert.deepEqual(await focusedChip(page), {inChips: true, kw: "tiktok", remove: true}, "Cancel returns focus to the × it came from");
  assert.equal(gh.json("companies.json").includes("tiktok"), true);
  assert.deepEqual(errors, []);
  await close();
});

test("a failed save keeps the input; a successful one clears it and keeps its confirmation ahead of the scan progress", async () => {
  const {page, gh, close, errors} = await openDialog();
  gh.state.failNext = {status: 500, message: "boom"};
  await page.locator("#coInput").fill("waymo two");
  await page.locator("#coAdd").click();
  await page.waitForFunction(() => /^Save failed/.test(document.getElementById("coMsg").textContent));
  assert.equal(await page.locator("#coInput").inputValue(), "waymo two", "what was typed survives a failed save");
  assert.equal(gh.json("companies.json").includes("waymo two"), false);

  const raw = "Zed-Robotics";
  const kw = norm(raw);
  assert.notEqual(kw, raw.toLowerCase(), "the example needs the 'saved as' suffix");
  assert.equal(companies.includes(kw), false);
  await page.locator("#coInput").fill(raw);
  assert.equal(await page.locator("#coPreview").innerText(), `will match as: ${kw}`);
  await page.locator("#coAdd").click();
  await page.waitForFunction(() => /(Watching|Waiting)/.test(document.getElementById("coMsg").textContent));
  const msg = await page.locator("#coMsg").innerText();
  assert.ok(msg.startsWith(`Saved ‘${raw}’ (as ‘${kw}’) — a scan starts within a minute (push trigger). `), msg);
  assert.equal(await page.locator("#coInput").inputValue(), "", "the input clears after a successful save");
  assert.equal(gh.json("companies.json").includes(kw), true);
  assert.equal(await page.locator(`#coChips .kw[data-kw="${kw}"]`).count(), 1);
  assert.deepEqual(errors, []);
  await close();
});

test("the actions and the status line sit above the chip cloud", async () => {
  const {page, close} = await openDialog();
  const layout = await page.evaluate(() => {
    const top = (id) => document.getElementById(id).getBoundingClientRect().top;
    const msgFirst = !!(document.getElementById("coMsg").compareDocumentPosition(document.getElementById("coChips")) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {msgFirst, input: top("coInput"), block: top("coBlock"), rescan: top("coRescan"), chips: top("coChips")};
  });
  assert.equal(layout.msgFirst, true, "#coMsg precedes #coChips in the DOM");
  assert.ok(layout.input < layout.block && layout.block <= layout.rescan && layout.block < layout.chips, JSON.stringify(layout));
  await close();
});

test("+ Role splits locations on semicolons, so a 'City, Country' name stays one place", async () => {
  const {page, gh, close, errors} = await openAddRole();
  assert.equal(await page.locator('label[for="mLoc"]').innerText(), "Locations (optional, semicolon-separated)");
  assert.equal(await page.locator("#mLoc").getAttribute("placeholder"), "San Jose, CA; Taipei, Taiwan");

  const added = async (title, loc) => {
    await page.locator("#mCompany").fill("Formosa Robotics");
    await page.locator("#mTitle").fill(title);
    await page.locator("#mLoc").fill(loc);
    await page.locator("#mAdd").click();
    await page.waitForFunction((t) => document.getElementById("mMsg").textContent === `Added ‘Formosa Robotics — ${t}’.`, title);
    assert.equal(await page.locator("#mLoc").inputValue(), "", "the form clears after a save");
    const role = gh.json("manual.json").at(-1);
    assert.equal(role.title, title);
    return {role, meta: await page.locator(`.row[data-id="${role.id}"] .meta`).innerText()};
  };

  const one = await added("Firmware Engineer", " Taipei, Taiwan ");
  assert.deepEqual(one.role.locations, ["Taipei, Taiwan"]);
  assert.ok(one.meta.startsWith("Taipei, Taiwan · added by you"), one.meta);

  const two = await added("Perception Engineer", "San Jose, CA; Taipei, Taiwan");
  assert.deepEqual(two.role.locations, ["San Jose, CA", "Taipei, Taiwan"]);
  assert.ok(two.meta.startsWith("San Jose, CA; Taipei, Taiwan · added by you"), two.meta);

  assert.equal(gh.json("manual.json").length, manual.length + 2);
  assert.deepEqual(errors, []);
  await close();
});
