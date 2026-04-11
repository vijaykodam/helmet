// Dumps the raw CheckedOut HTML for parser debugging
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Reuse the built client
const configPath = resolve(process.env.HOME, ".config/helmet/config.json");
const { readFileSync } = await import("node:fs");
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const profile = config.profiles[0];

// Decode PIN
const decoded = Buffer.from(profile.pinObfuscated, "base64").toString("utf-8");
const pin = decoded.replace(/^helmet::/, "");

// Use the client to login and fetch
const { HelmetClient } = await import("../packages/helmet-client/dist/index.js");
const client = await HelmetClient.login({
  baseUrl: "https://helmet.finna.fi",
  cardNumber: profile.cardNumber,
  pin,
  debug: false,
});

// Access the session's get method through the client
// We need raw HTML, so let's use the session directly
import { HelmetSession } from "../packages/helmet-client/dist/session.js";
const session = new HelmetSession("https://helmet.finna.fi");
await session.login(profile.cardNumber, pin);
const resp = await session.get("/MyResearch/CheckedOut");
const html = await resp.text();

writeFileSync("/tmp/helmet-checkedout.html", html);
console.log("Saved to /tmp/helmet-checkedout.html");
console.log("HTML length:", html.length);

// Show first loan row structure
const rowMatch = html.match(/<tr[^>]*class="[^"]*myresearch-row[^"]*"[^>]*>[\s\S]*?<\/tr>/i);
if (rowMatch) {
  console.log("\n=== First myresearch-row ===");
  console.log(rowMatch[0].slice(0, 2000));
} else {
  console.log("\nNo myresearch-row found. Looking for other patterns...");
  // Try other selectors
  const patterns = [
    /class="[^"]*record[^"]*"/gi,
    /class="[^"]*result[^"]*"/gi,
    /class="[^"]*checked-?out[^"]*"/gi,
    /renewSelectedIDS/gi,
    /duedate|due-date|due_date/gi,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) console.log(`  ${p.source}: ${m.length} matches, first: ${m[0]}`);
  }
}
