#!/usr/bin/env node

import { input, password, select } from "@inquirer/prompts";
import { HelmetClient, AuthenticationError } from "@helmet/client";
import type { HelmetProfile, Loan, RenewalResult } from "@helmet/client";
import {
  loadConfig,
  saveConfig,
  obfuscateSecret,
  revealSecret,
  profileId,
  getConfigPath,
  type StoredProfile,
  type CliConfig,
} from "./config.js";

const BASE_URL = "https://helmet.finna.fi";

// ─── Argument parsing ───────────────────────────────────────────

const args = process.argv.slice(2);
const jsonFlag = args.includes("--json");
const allFlag = args.includes("--all");
const debugFlag = args.includes("--debug");

function getPositionalArgs(): string[] {
  return args.filter((a) => !a.startsWith("--"));
}

// ─── Main entry ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const positional = getPositionalArgs();
  const command = positional[0];
  const subcommand = positional[1];

  switch (command) {
    case "login":
      await handleLogin();
      break;
    case "loans":
      await handleLoans(subcommand);
      break;
    case "search":
      await handleSearch(positional.slice(1).join(" "));
      break;
    case "summary":
      await handleSummary();
      break;
    case "config":
      if (subcommand === "path") {
        output(getConfigPath());
      } else {
        output(`Config path: ${getConfigPath()}`);
      }
      break;
    case undefined:
      await handleInteractive();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

// ─── Commands ───────────────────────────────────────────────────

async function handleLogin(): Promise<void> {
  const cardNumber = await input({ message: "Library card number:" });
  const pin = await password({ message: "PIN:" });

  output("Logging in...");
  try {
    const client = await HelmetClient.login({
      baseUrl: BASE_URL,
      cardNumber,
      pin,
      debug: debugFlag,
    });

    // Save profile
    const config = await loadConfig();
    const id = profileId(cardNumber);
    const existing = config.profiles.findIndex((p) => p.id === id);
    const profile: StoredProfile = {
      id,
      cardNumber,
      pinObfuscated: obfuscateSecret(pin),
      displayName: null,
      lastUsedAt: new Date().toISOString(),
    };

    if (existing >= 0) {
      config.profiles[existing] = profile;
    } else {
      config.profiles.push(profile);
    }
    config.lastProfileId = id;
    await saveConfig(config);

    output("Login successful! Profile saved.");

    // Show a quick summary
    const loans = await client.loans.list();
    output(`You have ${loans.length} item(s) checked out.`);
  } catch (err) {
    if (err instanceof AuthenticationError) {
      console.error(`Login failed: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

async function handleLoans(subcommand: string | undefined): Promise<void> {
  const client = await getAuthenticatedClient();

  switch (subcommand) {
    case "list":
    case undefined: {
      const loans = await client.loans.list();
      if (jsonFlag) {
        outputJson(loans);
      } else {
        if (loans.length === 0) {
          output("No items checked out.");
          return;
        }
        output(`\n  Checked out items (${loans.length}):\n`);
        for (const loan of loans) {
          const status = loan.dueStatus === "overdue" ? " [OVERDUE]" : loan.dueStatus === "due" ? " [DUE SOON]" : "";
          const renew = loan.renewable ? " (renewable)" : "";
          output(`  ${loan.title}`);
          output(`    Due: ${loan.dueDate}${status}${renew}`);
          if (loan.author) output(`    Author: ${loan.author}`);
          if (loan.id) output(`    ID: ${loan.id}`);
          output("");
        }
      }
      break;
    }
    case "renew": {
      const targetId = getPositionalArgs()[2];
      if (!targetId && !allFlag) {
        console.error("Usage: helmet loans renew <id> or helmet loans renew --all");
        process.exit(1);
      }
      let results: RenewalResult[];
      if (allFlag) {
        output("Renewing all items...");
        results = await client.loans.renewAll();
      } else {
        output(`Renewing item ${targetId}...`);
        results = await client.loans.renew(targetId);
      }
      if (jsonFlag) {
        outputJson(results);
      } else {
        if (results.length === 0) {
          output("No renewal results returned. The items may not be renewable.");
        }
        for (const r of results) {
          const status = r.success ? "OK" : "FAILED";
          const detail = r.errorCode
            ? `${r.message ?? "no message"} (${r.errorCode})`
            : r.message ?? "no message";
          const dueInfo = r.newDueDate ? ` → new due: ${r.newDueDate}` : "";
          output(`  [${status}] ${r.id || "item"}: ${detail}${dueInfo}`);
        }
      }
      break;
    }
    default:
      console.error(`Unknown loans subcommand: ${subcommand}`);
      process.exit(1);
  }
}

async function handleSearch(query: string): Promise<void> {
  if (!query) {
    console.error("Usage: helmet search <query>");
    process.exit(1);
  }

  // Search doesn't require authentication
  const client = await HelmetClient.login({
    baseUrl: BASE_URL,
    cardNumber: "anonymous",
    pin: "",
    debug: debugFlag,
  }).catch(() => null);

  // Use the public API directly for search (no auth needed)
  const params = new URLSearchParams({
    lookfor: query,
    "filter[]": "building:0/Helmet/",
    limit: "20",
  });
  const resp = await globalThis.fetch(
    `https://api.finna.fi/v1/search?${params.toString()}`,
  );
  const data = (await resp.json()) as Record<string, unknown>;
  const records = (data.records ?? []) as Record<string, unknown>[];

  if (jsonFlag) {
    outputJson({ resultCount: data.resultCount, records });
  } else {
    output(`\n  Search results for "${query}" (${data.resultCount ?? 0} total):\n`);
    for (const r of records.slice(0, 20)) {
      output(`  ${r.title}`);
      if (r.primaryAuthor) output(`    Author: ${r.primaryAuthor}`);
      if (r.year) output(`    Year: ${r.year}`);
      output(`    ID: ${r.id}`);
      output("");
    }
  }
}

async function handleSummary(): Promise<void> {
  const client = await getAuthenticatedClient();
  const summary = await client.summary.get();

  if (jsonFlag) {
    outputJson(summary);
  } else {
    output("\n  === Helmet Library Summary ===\n");
    output(`  Total loans: ${summary.loans.length}`);
    if (summary.loansOverdue.length > 0) {
      output(`  OVERDUE: ${summary.loansOverdue.length} item(s)!`);
      for (const l of summary.loansOverdue) {
        output(`    - ${l.title} (due: ${l.dueDate})`);
      }
    }
    if (summary.loansDueSoon.length > 0) {
      output(`  Due soon: ${summary.loansDueSoon.length} item(s)`);
      for (const l of summary.loansDueSoon) {
        output(`    - ${l.title} (due: ${l.dueDate})`);
      }
    }
    output(`  Holds: ${summary.holds.length}`);
    output(`  Fines: ${summary.totalFines} EUR`);
    output("");
  }
}

async function handleInteractive(): Promise<void> {
  output("\n  Helmet Library CLI\n");

  const client = await getAuthenticatedClient();

  while (true) {
    const action = await select({
      message: "What would you like to do?",
      choices: [
        { name: "View loans", value: "loans" },
        { name: "Renew all", value: "renew-all" },
        { name: "Search catalog", value: "search" },
        { name: "Summary", value: "summary" },
        { name: "Exit", value: "exit" },
      ],
    });

    switch (action) {
      case "loans": {
        const loans = await client.loans.list();
        if (loans.length === 0) {
          output("  No items checked out.\n");
        } else {
          output(`\n  Checked out (${loans.length}):\n`);
          for (const l of loans) {
            const status = l.dueStatus === "overdue" ? " [OVERDUE]" : "";
            output(`  - ${l.title} (due: ${l.dueDate})${status}`);
          }
          output("");
        }
        break;
      }
      case "renew-all": {
        output("  Renewing all items...");
        const results = await client.loans.renewAll();
        for (const r of results) {
          const detail = r.errorCode ? ` (${r.errorCode})` : "";
          const dueInfo = r.newDueDate ? ` → ${r.newDueDate}` : "";
          output(`  [${r.success ? "OK" : "FAIL"}] ${r.message ?? r.id}${detail}${dueInfo}`);
        }
        output("");
        break;
      }
      case "search": {
        const query = await input({ message: "Search for:" });
        if (query) {
          await handleSearch(query);
        }
        break;
      }
      case "summary":
        await handleSummary();
        break;
      case "exit":
        return;
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────

async function getAuthenticatedClient(): Promise<HelmetClient> {
  const config = await loadConfig();

  let profile: StoredProfile | undefined;

  if (config.profiles.length === 0) {
    // No saved profiles — prompt for login
    output("No saved profiles. Please log in first.\n");
    await handleLogin();
    const refreshedConfig = await loadConfig();
    profile = refreshedConfig.profiles[0];
  } else if (config.profiles.length === 1) {
    profile = config.profiles[0];
  } else {
    // Multiple profiles — let user choose or use last
    const lastId = config.lastProfileId;
    profile = config.profiles.find((p) => p.id === lastId) ?? config.profiles[0];
  }

  if (!profile) {
    console.error("No profile available. Run: helmet login");
    process.exit(1);
  }

  const pin = revealSecret(profile.pinObfuscated);
  if (!pin) {
    console.error("Could not decrypt PIN. Please re-login: helmet login");
    process.exit(1);
  }

  const helmetProfile: HelmetProfile = {
    baseUrl: BASE_URL,
    cardNumber: profile.cardNumber,
    pin,
    debug: debugFlag,
  };

  try {
    const client = await HelmetClient.login(helmetProfile);

    // Update last used
    profile.lastUsedAt = new Date().toISOString();
    config.lastProfileId = profile.id;
    await saveConfig(config);

    return client;
  } catch (err) {
    if (err instanceof AuthenticationError) {
      console.error(`Authentication failed: ${err.message}`);
      console.error("Try logging in again: helmet login");
      process.exit(1);
    }
    throw err;
  }
}

function output(text: string): void {
  console.log(text);
}

function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function printUsage(): void {
  output(`
  Usage: helmet <command> [options]

  Commands:
    login                     Log in and save credentials
    loans list [--json]       List checked-out items
    loans renew <id> [--json] Renew a specific item
    loans renew --all [--json] Renew all renewable items
    search <query> [--json]   Search the catalog
    summary [--json]          Account summary
    config path               Show config file path

  Options:
    --json    Output as JSON (for agents)
    --all     Apply to all items
    --debug   Show debug HTTP logs
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
