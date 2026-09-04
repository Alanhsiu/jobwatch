#!/usr/bin/env python3
"""Static checks on index.html (spec §10.1 / §12.2): CSP meta with script-src and style-src 'self', no inline
style attributes or inline <script> bodies, the manifest link, the static #list fallback text, and every version
stamp (data-app, ?v= in index.html/app.js/sync.js) equal to APP_VERSION in lib.js. Exit 1 with one line per failure."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def app_version(lib: str) -> int:
    m = re.search(r"export const APP_VERSION\s*=\s*(\d+)", lib)
    if not m:
        raise SystemExit("assets/lib.js: APP_VERSION not found")
    return int(m.group(1))


def check_html(html: str, version: int) -> list[str]:
    problems: list[str] = []
    csp = re.search(r'<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"', html, re.I)
    if not csp:
        problems.append("CSP meta tag missing")
    else:
        for directive in ("default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self' https://api.github.com"):
            if directive not in csp.group(1):
                problems.append(f"CSP lacks `{directive}`")
    if re.search(r"<[^>]+\sstyle\s*=", html, re.I):
        problems.append("inline style= attribute found")
    for m in re.finditer(r"<script\b([^>]*)>(.*?)</script>", html, re.I | re.S):
        if m.group(2).strip():
            problems.append("inline <script> body found")
        if 'type="module"' not in m.group(1) or "src=" not in m.group(1):
            problems.append("<script> must be type=module with a src")
    if re.search(r"\son[a-z]+\s*=", html, re.I):
        problems.append("inline on*= event handler found")
    if not re.search(r'<link\s+rel="manifest"\s+href="manifest\.webmanifest"', html):
        problems.append("manifest link missing")
    if not re.search(r'<main id="list" tabindex="-1">\s*<div class="empty">Loading roles…', html):
        problems.append("static #list fallback text missing")
    for name in ("referrer", "robots", "viewport", "color-scheme"):
        if not re.search(rf'<meta\s+name="{name}"', html):
            problems.append(f"<meta name=\"{name}\"> missing")
    m = re.search(r'<html[^>]*\sdata-app="(\d+)"', html)
    if not m:
        problems.append("<html data-app> missing")
    elif int(m.group(1)) != version:
        problems.append(f"data-app={m.group(1)} but APP_VERSION={version}")
    stamps = [int(v) for v in re.findall(r"\?v=(\d+)", html)]
    if len(stamps) < 2:
        problems.append("index.html must reference assets/style.css?v=N and assets/app.js?v=N")
    problems += [f"index.html references ?v={v} (APP_VERSION={version})" for v in stamps if v != version]
    for dialog in ("dlgCompanies", "dlgSettings", "dlgSync", "dlgAddRole", "dlgShortcuts", "dlgConfirm", "dlgViews", "dlgSort"):
        if f'<dialog id="{dialog}"' not in html:
            problems.append(f"<dialog id=\"{dialog}\"> missing")
    return problems


def check_module_imports(name: str, source: str, version: int) -> list[str]:
    return [f"{name} imports ?v={v} (APP_VERSION={version})" for v in re.findall(r"\?v=(\d+)", source) if int(v) != version]


def main() -> int:
    version = app_version((ROOT / "assets" / "lib.js").read_text(encoding="utf-8"))
    problems = check_html((ROOT / "index.html").read_text(encoding="utf-8"), version)
    for rel in ("assets/app.js", "assets/sync.js"):
        problems += check_module_imports(rel, (ROOT / rel).read_text(encoding="utf-8"), version)
    for p in problems:
        print(f"check_html: {p}", file=sys.stderr)
    if not problems:
        print(f"check_html: OK (APP_VERSION={version})")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
