// In-page mock of the GitHub REST endpoints the tracker uses: Contents API (GET/PUT with blob shas, 409 on a stale
// sha, 422 on a sha for a missing file), GET /repos/{o}/{r}, workflow dispatch (204) and the workflow-runs list.
// Usage: const gh = await installGitHubMock(page, {"status.json": {...}}, {latency: {PUT: 1500}});
//        gh.json("status.json") -> current object; gh.state.log -> [{method, path, status}]
import {createHash} from "node:crypto";

export function blobSha(text) {
  return createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(String(s || "").replace(/\n/g, ""), "base64").toString("utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {import("playwright").Page} page
 * @param {Record<string, unknown>} initial file name → object (or raw string) present in the mock repo
 * @param {{latency?: Record<string, number>, requireAuth?: boolean, runs?: object[], defaultBranch?: string}} [opts]
 */
export async function installGitHubMock(page, initial = {}, opts = {}) {
  const files = {};
  for (const [name, obj] of Object.entries(initial)) setFile(files, name, obj);
  const state = {files, log: [], failNext: null, staleShaOnce: false, dispatches: 0, runs: opts.runs || [], latency: opts.latency || {}};

  await page.route(/^https:\/\/api\.github\.com\/.*/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const entry = {method, path: url.pathname, status: 0, at: Date.now()};
    state.log.push(entry);
    const reply = (status, body) => {
      entry.status = status;
      return route.fulfill({status, contentType: "application/json", body: body === undefined ? "" : JSON.stringify(body)});
    };
    const stale = method === "PUT" && state.staleShaOnce;             // decided on arrival, before the latency sleep
    if (stale) state.staleShaOnce = false;
    if (state.latency[method]) await sleep(state.latency[method]);
    if (state.failNext) {
      const f = state.failNext;
      state.failNext = null;
      return reply(f.status, {message: f.message || "mock failure"});
    }
    if (opts.requireAuth && !(req.headers().authorization || "").startsWith("Bearer ")) return reply(401, {message: "Bad credentials"});

    const repoMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!repoMatch) return reply(404, {message: "mock: unknown path"});
    const rest = repoMatch[3] || "";
    if (!rest && method === "GET") return reply(200, {default_branch: opts.defaultBranch || "main", permissions: {push: true}});
    if (rest.match(/^\/actions\/workflows\/[^/]+\/dispatches$/) && method === "POST") {
      state.dispatches++;
      return reply(204);
    }
    if (rest.match(/^\/actions\/workflows\/[^/]+\/runs$/) && method === "GET") {
      const status = url.searchParams.get("status");
      const runs = status ? state.runs.filter((r) => r.conclusion === status || r.status === status) : state.runs;
      return reply(200, {total_count: runs.length, workflow_runs: runs.slice(0, Number(url.searchParams.get("per_page")) || 30)});
    }
    const contents = rest.match(/^\/contents\/(.+)$/);
    if (!contents) return reply(404, {message: `mock: unhandled ${method} ${url.pathname}`});
    const name = decodeURIComponent(contents[1]);
    if (method === "GET") {
      const f = files[name];
      if (!f) return reply(404, {message: "Not Found"});
      return reply(200, {name, path: name, sha: f.sha, content: b64(f.text), encoding: "base64"});
    }
    if (method === "PUT") {
      const body = JSON.parse(req.postData() || "{}");
      const f = files[name];
      if (stale && f) return reply(409, {message: `${name} does not match ${f.sha}`});
      if (f && body.sha !== f.sha) return reply(409, {message: `${name} does not match ${f.sha}`});
      if (!f && body.sha) return reply(422, {message: "sha wasn't supplied"});
      setFile(files, name, unb64(body.content));
      return reply(f ? 200 : 201, {content: {name, path: name, sha: files[name].sha}, commit: {sha: "deadbeef", message: body.message}});
    }
    return reply(405, {message: "mock: method not allowed"});
  });

  return {
    state,
    json(name) {
      return JSON.parse(state.files[name].text);
    },
    set(name, obj) {
      setFile(files, name, obj);
    },
    del(name) {
      delete files[name];
    },
    puts(name) {
      return state.log.filter((e) => e.method === "PUT" && e.path.endsWith(`/contents/${name}`));
    },
  };
}

function setFile(files, name, obj) {
  const text = typeof obj === "string" ? obj : `${JSON.stringify(obj, null, 1)}\n`;
  files[name] = {text, sha: blobSha(text)};
}
