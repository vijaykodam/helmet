// Dumps the raw Holds HTML for parser debugging
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const configPath = resolve(process.env.HOME, ".config/helmet/config.json");
const { readFileSync } = await import("node:fs");
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const profile = config.profiles[0];

const decoded = Buffer.from(profile.pinObfuscated, "base64").toString("utf-8");
const pin = decoded.replace(/^helmet::/, "");

import { HelmetSession } from "../packages/helmet-client/dist/session.js";
const session = new HelmetSession("https://helmet.finna.fi");
await session.login(profile.cardNumber, pin);
const resp = await session.get("/MyResearch/Holds");
const html = await resp.text();

writeFileSync("/tmp/helmet-holds.html", html);
console.log("Saved to /tmp/helmet-holds.html");
console.log("HTML length:", html.length);

// Show first hold row structure
const rowMatch = html.match(/<tr[^>]*class="[^"]*myresearch-row[^"]*"[^>]*>[\s\S]*?<\/tr>/i);
if (rowMatch) {
  console.log("\n=== First myresearch-row ===");
  console.log(rowMatch[0]);
} else {
  console.log("\nNo myresearch-row found. Searching for other patterns...");
  const patterns = [
    /cancelSelectedIDS/gi,
    /class="[^"]*record[^"]*"/gi,
    /class="[^"]*hold[^"]*"/gi,
    /noutokirjasto|pickup/gi,
    /jonotuspaikka|queue/gi,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) console.log(`  ${p.source}: ${m.length} matches, first: ${m[0]}`);
  }
}
