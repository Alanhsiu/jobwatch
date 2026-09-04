// WCAG AA check of the §10.12 tokens: a regex over `--name:#hex` in the three token blocks of style.css (not a CSS
// parser) plus the relative-luminance formula. Also pins the deliberate duplicate: both dark blocks must be identical.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const css = readFileSync(new URL("../../assets/style.css", import.meta.url), "utf8");
const TEXT = ["ink", "muted", "drop", "seen", "applied", "oa", "interview", "offer", "rejected", "star", "ok", "warn", "err", "link", "visited"];
const BACKGROUNDS = ["bg", "surface", "note-bg", "chip-bg", "drop-bg", "seen-bg", "applied-bg", "oa-bg", "interview-bg", "offer-bg", "rejected-bg"];

function block(startRe) {
  const start = css.search(startRe);
  assert.ok(start >= 0, `token block ${startRe} not found`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open, i + 1);
  }
  assert.fail("unbalanced token block");
}

function tokens(text) {
  return Object.fromEntries([...text.matchAll(/--([a-z-]+):(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const light = tokens(block(/^:root\{color-scheme:light;/m));
const darkAuto = tokens(block(/@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{/));
const darkForced = tokens(block(/^:root\[data-theme=dark\]\{/m));

for (const [name, t] of [["light", light], ["dark", darkAuto]]) {
  test(`${name}_text_tokens_are_AA_on_every_background`, () => {
    for (const fg of TEXT) for (const bg of BACKGROUNDS) {
      assert.ok(t[fg] && t[bg], `${name}: missing token ${fg}/${bg}`);
      assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name}: --${fg} on --${bg} is ${ratio(t[fg], t[bg]).toFixed(2)} < 4.5`);
    }
  });
  test(`${name}_non_text_tokens_are_3_to_1`, () => {
    for (const bg of ["bg", "surface"]) for (const fg of ["faint", "focus", "new"]) assert.ok(ratio(t[fg], t[bg]) >= 3, `${name}: --${fg} on --${bg}`);
    assert.ok(ratio(t["new-ink"], t.new) >= 4.5, `${name}: NEW badge text`);
    assert.ok(ratio(t["new-ink"], t.applied) >= 4.5, `${name}: primary button text on --applied`);
  });
}

test("dark_blocks_identical", () => {
  assert.ok(Object.keys(darkAuto).length > 30, "dark block has too few tokens");
  assert.deepEqual(darkForced, darkAuto, "the :root[data-theme=dark] block must repeat the prefers-color-scheme block token for token");
  assert.deepEqual(Object.keys(darkAuto).sort(), Object.keys(light).sort(), "light and dark blocks must define the same token names");
});
