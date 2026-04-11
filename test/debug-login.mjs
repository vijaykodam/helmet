import { CookieJar } from "tough-cookie";
import { fetch } from "undici";
import { writeFileSync } from "node:fs";

const BASE_URL = "https://helmet.finna.fi";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

const jar = new CookieJar();

async function req(path, init = {}) {
  const url = new URL(path, BASE_URL).toString();
  const cookie = jar.getCookieStringSync(url);
  const headers = new Headers();
  if (init.headers) {
    for (const [k, v] of Object.entries(init.headers)) headers.set(k, v);
  }
  headers.set("User-Agent", USER_AGENT);
  headers.set("Referer", `${BASE_URL}/`);
  if (cookie) headers.set("Cookie", cookie);

  const resp = await fetch(url, { ...init, headers });

  const ha = resp.headers;
  const sc = ha.getSetCookie?.() ?? [];
  for (const c of sc) jar.setCookieSync(c, url);
  if (!sc.length) {
    const s = ha.get("set-cookie");
    if (s) jar.setCookieSync(s, url);
  }
  return resp;
}

// Step 1: GET login page
console.log("=== Step 1: GET /MyResearch/UserLogin ===");
const loginResp = await req("/MyResearch/UserLogin", { redirect: "manual" });
console.log("Status:", loginResp.status);
console.log("Location:", loginResp.headers.get("location"));
console.log("Cookies:", jar.getCookiesSync(BASE_URL).map(c => `${c.key}=${c.value.slice(0,10)}...`));

// Follow redirect if any
let html;
if (loginResp.status >= 300 && loginResp.status < 400) {
  const loc = loginResp.headers.get("location");
  console.log("\n=== Following redirect to:", loc, "===");
  const r2 = await req(loc.startsWith("http") ? new URL(loc).pathname + new URL(loc).search : loc);
  console.log("Status:", r2.status);
  html = await r2.text();
} else {
  html = await loginResp.text();
}

// Extract all forms
console.log("\n=== Forms found ===");
const formRegex = /<form[^>]*>([\s\S]*?)<\/form>/gi;
let match;
let formCount = 0;
while ((match = formRegex.exec(html)) !== null) {
  formCount++;
  const formTag = html.slice(match.index, match.index + 300);
  console.log(`\nForm ${formCount}:`, formTag.match(/<form[^>]*>/)?.[0]);

  // Extract inputs
  const inputRegex = /<input[^>]*>/gi;
  let inp;
  while ((inp = inputRegex.exec(match[1])) !== null) {
    console.log("  Input:", inp[0]);
  }
  // Extract selects
  const selectRegex = /<select[^>]*>/gi;
  let sel;
  while ((sel = selectRegex.exec(match[1])) !== null) {
    console.log("  Select:", sel[0]);
  }
}

// Also look for any login-related elements
console.log("\n=== Login-related elements ===");
const loginPatterns = [
  /name="[^"]*user[^"]*"/gi,
  /name="[^"]*pass[^"]*"/gi,
  /name="[^"]*login[^"]*"/gi,
  /name="[^"]*csrf[^"]*"/gi,
  /name="[^"]*hash[^"]*"/gi,
  /name="[^"]*cat_[^"]*"/gi,
  /name="[^"]*card[^"]*"/gi,
  /name="[^"]*target[^"]*"/gi,
  /id="[^"]*login[^"]*"/gi,
];
for (const pat of loginPatterns) {
  const matches = html.match(pat);
  if (matches) {
    console.log(`  ${pat.source}:`, matches);
  }
}

// Save full HTML for inspection
writeFileSync("/tmp/helmet-login-page.html", html);
console.log("\n=== Full HTML saved to /tmp/helmet-login-page.html ===");
console.log("HTML length:", html.length);
