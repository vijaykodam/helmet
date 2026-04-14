#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isUnauthenticatedPageHtml } from "../dist/parsers/auth-detect.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Synthetic fixtures modeled on live helmet.finna.fi responses captured
// via Playwright on 2026-04-14. Shapes verified against real HTML for
// /MyResearch/CheckedOut, /MyResearch/Holds, and /MyResearch/Fines.

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="fi"><head><title>Kirjaudu | helmet.fi</title></head>
<body>
  <form method="post" action="/MyResearch/Home" name="loginForm" id="loginForm">
    <input type="text" name="username">
    <input type="password" name="password">
    <input type="hidden" name="csrf" value="abc123">
    <input type="submit" name="processLogin" value="Kirjaudu">
  </form>
</body></html>`;

const AUTHED_HOLDS_HTML = `<!DOCTYPE html>
<html lang="fi"><head><title>Varaukset | helmet.fi</title></head>
<body>
  <nav class="myresearch-menu"><a href="/MyResearch/CheckedOut">Lainat</a></nav>
  <table>
    <tr class="myresearch-row">
      <td><h3 class="record-title"><a>Example Book Title</a></h3>
          <div class="holds-status-information">
            <strong>Noutopaikka:</strong> Viherlaakso
          </div>
      </td>
    </tr>
  </table>
</body></html>`;

const AUTHED_LOANS_HTML = `<!DOCTYPE html>
<html lang="fi"><head><title>Lainat | helmet.fi</title></head>
<body>
  <nav class="myresearch-menu"></nav>
  <table>
    <tr class="myresearch-row">
      <td class="status-column"><strong>Eräpäivä: 1.5.2026</strong></td>
    </tr>
  </table>
</body></html>`;

const AUTHED_EMPTY_FINES_HTML = `<!DOCTYPE html>
<html lang="fi"><head><title>Maksut | helmet.fi</title></head>
<body><nav class="myresearch-menu"></nav><p>Ei maksuja.</p></body></html>`;

// Swedish and English locale variants of the login page — the detector must
// still fire so agents serving Finna in these locales are not silently empty.
const LOGIN_PAGE_SV = `<html><head><title>Logga in | helmet.fi</title></head>
<body><form id="loginForm"></form></body></html>`;

const LOGIN_PAGE_EN = `<html><head><title>Log in | helmet.fi</title></head>
<body><input name="processLogin"></body></html>`;

let failed = 0;
function check(label, actual, expected) {
  try {
    assert.equal(actual, expected);
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${label}: expected ${expected}, got ${actual}`);
  }
}

console.log("isUnauthenticatedPageHtml:");
check("login page (Finnish)", isUnauthenticatedPageHtml(LOGIN_PAGE_HTML), true);
check("login page (Swedish)", isUnauthenticatedPageHtml(LOGIN_PAGE_SV), true);
check("login page (English)", isUnauthenticatedPageHtml(LOGIN_PAGE_EN), true);
check("authed holds page", isUnauthenticatedPageHtml(AUTHED_HOLDS_HTML), false);
check("authed loans page", isUnauthenticatedPageHtml(AUTHED_LOANS_HTML), false);
check("authed empty fines page", isUnauthenticatedPageHtml(AUTHED_EMPTY_FINES_HTML), false);

// If real captured fixtures are present locally (gitignored), also validate against them.
const localFixtures = [
  ["real login-page", "login-page.html", true],
  ["real authed-loans", "authed-loans.html", false],
  ["real authed-holds", "authed-holds.html", false],
];
for (const [label, file, expected] of localFixtures) {
  const path = join(__dirname, "fixtures", file);
  if (existsSync(path)) {
    const html = readFileSync(path, "utf8");
    check(label + " (local fixture)", isUnauthenticatedPageHtml(html), expected);
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll passed.`);
