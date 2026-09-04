// Shared plumbing for the specs: serve a COPY of the repo root (never the repo itself), launch the browser
// (`PW_CHANNEL=chrome` locally, bundled chromium in CI), collect console/page errors and external requests.
import {chromium} from "playwright";
import {spawn} from "node:child_process";
import {cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync} from "node:fs";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = path.join(ROOT, "e2e", "fixtures");
export const REAL = path.join(ROOT, "tests", "fixtures", "real");
const SHELL_FILES = ["index.html", "manifest.webmanifest"];

const servers = new Set();
process.on("exit", () => { for (const s of servers) s.kill(); });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { for (const s of servers) s.kill(); process.exit(1); });

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Fixture meta.json with the bot's clocks placed relative to now, so the scan pill/new-view logic is stable. */
export function freshMeta(overrides = {}) {
  const meta = readJson(path.join(FIXTURES, "meta.json"));
  const now = Math.floor(Date.now() / 1000);
  return {...meta, last_run: now - 2 * 3600, last_change: now - 2 * 3600, ...overrides};
}

/**
 * Copy the tracker shell + assets into a temp dir, drop the given data files next to them and serve the copy with
 * python3 -m http.server on a free port. `files` maps a file name to an object (JSON) or a string (verbatim).
 * @returns {Promise<{url: string, dir: string, stop: () => void}>}
 */
export async function serveCopy(files = {}, {shellFrom = ROOT} = {}) {
  const dir = mkdtempSync(path.join(process.env.E2E_TMP || tmpdir(), "jobwatch-e2e-"));   // E2E_TMP: keep copies out of /tmp when asked
  mkdirSync(path.join(dir, "assets"));
  for (const f of SHELL_FILES) cpSync(path.join(shellFrom, f), path.join(dir, f));
  cpSync(path.join(ROOT, "assets"), path.join(dir, "assets"), {recursive: true});
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 1)}\n`);
  }
  const port = await freePort();
  const child = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", dir], {stdio: "ignore"});
  servers.add(child);
  const url = `http://127.0.0.1:${port}/`;
  await waitFor(url);
  return {
    url, dir,
    stop() {
      child.kill();
      servers.delete(child);
      rmSync(dir, {recursive: true, force: true});
    },
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const {port} = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${url}index.html`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`static server at ${url} did not start`);
}

export function launch() {
  return chromium.launch({channel: process.env.PW_CHANNEL || undefined, args: ["--no-sandbox"]});
}

/** Attach error/request collectors to a page; `origin` requests are expected, everything else is "external". */
export function watch(page, origin) {
  const errors = [];
  const external = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const url = m.location()?.url || "";
    if (/config\.json|meta\.json|favicon/.test(url)) return;      // optional files: the browser logs their 404s itself
    if (/api\.github\.com/.test(url) && /Failed to load resource/.test(m.text())) return;   // the mock's scripted 4xx/5xx replies; the app's handling is what specs assert
    errors.push(`console: ${m.text()}`);
  });
  page.on("request", (r) => { if (!r.url().startsWith(origin)) external.push(r.url()); });
  page.on("response", (r) => { if (r.status() >= 400 && r.url().startsWith(origin) && !/favicon|meta\.json|config\.json/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
  return {errors, external};
}

/** Pre-seed localStorage before the page's scripts run. */
export function seedStorage(page, entries) {
  return page.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, entries);
}

export function realFile(name) {
  const p = path.join(REAL, name);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
