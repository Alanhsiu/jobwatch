// node --test 'tests/js/*.test.mjs' — cache-busting handshake (§2 Q2): every `?v=` and `data-app` must equal APP_VERSION.
import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import {APP_VERSION} from "../../assets/lib.js";

const root = new URL("../../", import.meta.url);
const FILES = ["index.html", "assets/app.js", "assets/sync.js"];

function importsVersioned(source, module) {
  return new RegExp(`from\\s+["']\\./${module}\\.js\\?v=${APP_VERSION}["']`).test(source);
}

function read(rel) {
  const path = new URL(rel, root);
  if (!existsSync(path)) assert.fail(`${rel} is missing — it must exist and reference APP_VERSION=${APP_VERSION}`);
  return readFileSync(path, "utf8");
}

test("app_version_is_a_positive_integer", () => {
  assert.ok(Number.isInteger(APP_VERSION) && APP_VERSION > 0);
});

for (const rel of FILES) {
  test(`every_?v=_in_${rel}_equals_APP_VERSION`, () => {
    const text = read(rel);
    const versions = [...text.matchAll(/\?v=(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(versions.length > 0, `${rel} references no ?v= asset`);
    for (const v of versions) assert.equal(v, APP_VERSION, `${rel} references ?v=${v}`);
  });
}

test("index_html_data_app_equals_APP_VERSION", () => {
  const html = read("index.html");
  const m = html.match(/<html[^>]*\sdata-app="(\d+)"/);
  assert.ok(m, 'index.html lacks <html ... data-app="N">');
  assert.equal(Number(m[1]), APP_VERSION);
});

test("index_html_references_versioned_style_and_app", () => {
  const html = read("index.html");
  assert.ok(html.includes(`assets/style.css?v=${APP_VERSION}`), `index.html must link assets/style.css?v=${APP_VERSION}`);
  assert.ok(html.includes(`assets/app.js?v=${APP_VERSION}`), `index.html must load assets/app.js?v=${APP_VERSION}`);
});

test("app_js_imports_lib_and_sync_with_version", () => {
  const app = read("assets/app.js");
  assert.ok(importsVersioned(app, "lib"), `app.js must import ./lib.js?v=${APP_VERSION}`);
  assert.ok(importsVersioned(app, "sync"), `app.js must import ./sync.js?v=${APP_VERSION}`);
});

test("sync_js_imports_lib_with_version", () => {
  const sync = read("assets/sync.js");
  assert.ok(importsVersioned(sync, "lib"), `sync.js must import ./lib.js?v=${APP_VERSION} — the same URL as app.js, or the browser loads two copies`);
});
