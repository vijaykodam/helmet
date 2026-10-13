#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isUnauthenticatedPageHtml,
  detectLoginFailure,
  extractLoginError,
  extractLoginFormAction,
} from "../dist/parsers/auth-detect.js";
import { HelmetSession, AuthenticationError } from "../dist/session.js";

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
            <strong>Noutopaikka:</strong> Sample Branch
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
    console.log(`  ok   ${label}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${label}: expected ${expected}, got ${actual}`);
  }
}

console.log("isUnauthenticatedPageHtml:");
check("login page (Finnish)", isUnauthenticatedPageHtml(LOGIN_PAGE_HTML), true);
check("login page (Swedish)", isUnauthenticatedPageHtml(LOGIN_PAGE_SV), true);
check("login page (English)", isUnauthenticatedPageHtml(LOGIN_PAGE_EN), true);
check("authed holds page", isUnauthenticatedPageHtml(AUTHED_HOLDS_HTML), false);
check("authed loans page", isUnauthenticatedPageHtml(AUTHED_LOANS_HTML), false);
check("authed empty fines page", isUnauthenticatedPageHtml(AUTHED_EMPTY_FINES_HTML), false);

// Bad-PIN response: Finna re-renders the login page (200) with a flash
// message. Live markup puts `action` before `id`, which broke the old
// regex check and let wrong PINs pass as a successful login (0.3.1).
const LOGIN_FAILED_HTML = LOGIN_PAGE_HTML.replace(
  "<body>",
  '<body><div role="alert" class="flash-message alert alert-danger">Virheelliset\n  tunnukset</div>',
);
const LOGIN_FORM_ID_FIRST = `<html><body>
  <form id="loginForm" name="loginForm" action="/Custom/Login" method="post"></form>
</body></html>`;

console.log("\ndetectLoginFailure:");
check("bad PIN page returns flash text", detectLoginFailure(LOGIN_FAILED_HTML), "Virheelliset tunnukset");
check("login page without flash returns empty string", detectLoginFailure(LOGIN_PAGE_HTML), "");
check("authed page returns null", detectLoginFailure(AUTHED_LOANS_HTML), null);

console.log("\nextractLoginError:");
check("nested markup in alert", extractLoginError('<div class="alert alert-danger"><div><b>Tunnus/salasana</b> ei täsmää</div></div>'), "Tunnus/salasana ei täsmää");
check("no alert returns empty string", extractLoginError(LOGIN_PAGE_HTML), "");

console.log("\nextractLoginFormAction:");
check("action before id (live order)", extractLoginFormAction(LOGIN_PAGE_HTML), "/MyResearch/Home");
check("id before action", extractLoginFormAction(LOGIN_FORM_ID_FIRST), "/Custom/Login");
check("no login form", extractLoginFormAction(AUTHED_LOANS_HTML), null);

console.log("\nHelmetSession re-auth cooldown:");
{
  const fresh = new HelmetSession("https://example.invalid");
  fresh["markLoggedIn"]("123", "0000", false);
  let err = null;
  try {
    await fresh.tryReauth();
  } catch (e) {
    err = e;
  }
  check("no re-login right after a fresh login", err instanceof AuthenticationError, true);
  check("error names the credentials", /card number and PIN/.test(err?.message ?? ""), true);

  // A verified login does not start the cooldown, so tryReauth goes on to
  // login(), which fails on the network (example.invalid), not on the cooldown.
  const verified = new HelmetSession("https://example.invalid");
  verified["markLoggedIn"]("123", "0000", true);
  let err2 = null;
  try {
    await verified.tryReauth();
  } catch (e) {
    err2 = e;
  }
  check("verified login allows re-login", err2 !== null && !(err2 instanceof AuthenticationError), true);
}

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
    check(
      label + " login-failure detection (local fixture)",
      detectLoginFailure(html) !== null,
      expected,
    );
  }
}
const realLogin = join(__dirname, "fixtures", "login-page.html");
if (existsSync(realLogin)) {
  check(
    "real login-page form action (local fixture)",
    extractLoginFormAction(readFileSync(realLogin, "utf8")),
    "/MyResearch/Home",
  );
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll passed.`);
