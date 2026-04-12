// Dumps the /Record/{id}/Hold form HTML so we can see what the place-hold
// form actually looks like on Finna.
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const recordId = process.argv[2];
if (!recordId) {
  console.error("Usage: node test/dump-hold-form.mjs <record-id>");
  process.exit(1);
}

const configPath = resolve(process.env.HOME, ".config/helmet/config.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const profile = config.profiles[0];
const pin = Buffer.from(profile.pinObfuscated, "base64")
  .toString("utf-8")
  .replace(/^helmet::/, "");

const { HelmetSession } = await import("../dist/session.js");
const session = new HelmetSession("https://helmet.finna.fi", { debug: true });
await session.login(profile.cardNumber, pin);

const path = `/Record/${encodeURIComponent(recordId)}/Hold`;
const resp = await session.get(path);
const html = await resp.text();

writeFileSync("/tmp/helmet-hold-form.html", html);
console.log("\nSaved to /tmp/helmet-hold-form.html");
console.log("HTML length:", html.length);

// Probes
const patterns = [
  /<select[^>]*name="[^"]*"[^>]*>/gi,
  /name="gatheredDetails\[[^"]+\]"/gi,
  /name="pickUpLocation"/gi,
  /pickUpLocation/gi,
  /<form[^>]*>/gi,
  /csrf/gi,
  /alert-(success|danger|warning)/gi,
  /login/gi,
];
for (const p of patterns) {
  const m = html.match(p);
  console.log(`  ${p.source}: ${m ? m.length : 0} matches${m ? ` → ${m.slice(0, 3).join(" | ")}` : ""}`);
}
