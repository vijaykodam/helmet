#!/usr/bin/env node

import { input, password, select, confirm } from "@inquirer/prompts";
import { HelmetClient } from "./client.js";
import { AuthenticationError } from "./session.js";
import { VERSION } from "./version.js";
import type { HelmetProfile, RenewalResult } from "./types.js";
import {
  loadConfig,
  saveConfig,
  obfuscateSecret,
  revealSecret,
  profileId,
  getConfigPath,
  maskCardNumber,
  profileLabel,
  resolveProfile,
  loadSessionCache,
  saveSessionCache,
  clearSessionCache,
  type StoredProfile,
  type CliConfig,
} from "./config.js";

const BASE_URL = "https://helmet.finna.fi";

// ─── Argument parsing ───────────────────────────────────────────

const rawArgs = process.argv.slice(2);

interface ParsedArgs {
  positional: string[];
  json: boolean;
  all: boolean;
  debug: boolean;
  profile: string | null;
  allProfiles: boolean;
  comment: string | null;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  let json = false;
  let all = false;
  let debug = false;
  let profile: string | null = null;
  let allProfiles = false;
  let comment: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") json = true;
    else if (a === "--all") all = true;
    else if (a === "--debug") debug = true;
    else if (a === "--all-profiles") allProfiles = true;
    else if (a === "--profile") {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        console.error("Error: --profile requires a value (id, card number, or display name).");
        process.exit(1);
      }
      profile = next;
      i++;
    } else if (a.startsWith("--profile=")) {
      profile = a.slice("--profile=".length);
    } else if (a === "--comment") {
      const next = args[i + 1];
      if (next === undefined) {
        console.error("Error: --comment requires a value.");
        process.exit(1);
      }
      comment = next;
      i++;
    } else if (a.startsWith("--comment=")) {
      comment = a.slice("--comment=".length);
    } else if (a.startsWith("--")) {
      // Unknown flag — leave silent for forward-compat; treat as passthrough ignored.
    } else {
      positional.push(a);
    }
  }

  return { positional, json, all, debug, profile, allProfiles, comment };
}

const parsed = parseArgs(rawArgs);
const { positional, json: jsonFlag, all: allFlag, debug: debugFlag } = parsed;

if (parsed.profile && parsed.allProfiles) {
  console.error("Error: --profile and --all-profiles are mutually exclusive.");
  process.exit(1);
}

// ─── Main entry ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = positional[0];
  const subcommand = positional[1];

  if (
    command === "version" ||
    rawArgs.includes("--version") ||
    rawArgs.includes("-V")
  ) {
    output(VERSION);
    return;
  }

  switch (command) {
    case "login":
      rejectAllProfiles("login");
      await handleLogin();
      break;
    case "loans":
      await handleLoans(subcommand);
      break;
    case "holds":
      await handleHolds(subcommand, positional.slice(2));
      break;
    case "fines":
      await handleFines();
      break;
    case "search":
      rejectAllProfiles("search");
      if (parsed.profile) {
        console.error("Error: search is unauthenticated; --profile has no effect. Remove it.");
        process.exit(1);
      }
      await handleSearch(positional.slice(1).join(" "));
      break;
    case "summary":
      await handleSummary();
      break;
    case "profiles":
      rejectAllProfiles("profiles");
      await handleProfiles(subcommand, positional.slice(2));
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

function rejectAllProfiles(command: string): void {
  if (parsed.allProfiles) {
    console.error(`Error: --all-profiles is not supported for "${command}".`);
    process.exit(1);
  }
}

// ─── Commands ───────────────────────────────────────────────────

async function handleLogin(): Promise<void> {
  const cardNumber = await input({ message: "Library card number:" });
  const pin = await password({ message: "PIN:" });

  const config = await loadConfig();
  const id = profileId(cardNumber);
  const existing = config.profiles.find((p) => p.id === id);

  const displayName = await input({
    message: "Display name (optional, e.g. Alice):",
    default: existing?.displayName ?? undefined,
  });

  output("Logging in...");
  try {
    // Discard any cached session belonging to a previous login with this id.
    await clearSessionCache(id);

    const client = await HelmetClient.login({
      baseUrl: BASE_URL,
      cardNumber,
      pin,
      debug: debugFlag,
    });

    const profile: StoredProfile = {
      id,
      cardNumber,
      pinObfuscated: obfuscateSecret(pin),
      displayName: displayName.trim() === "" ? null : displayName.trim(),
      lastUsedAt: new Date().toISOString(),
    };

    const existingIndex = config.profiles.findIndex((p) => p.id === id);
    if (existingIndex >= 0) {
      config.profiles[existingIndex] = profile;
    } else {
      config.profiles.push(profile);
    }
    config.lastProfileId = id;
    await saveConfig(config);

    output(`Login successful! Profile saved as ${profileLabel(profile)}.`);

    const loans = await client.loans.list();
    output(`You have ${loans.length} item(s) checked out.`);

    // Persist the authenticated jar so subsequent invocations skip the login handshake.
    try {
      await saveSessionCache(id, client.exportState());
    } catch {
      // Cache is best-effort.
    }
  } catch (err) {
    if (err instanceof AuthenticationError) {
      console.error(`Login failed: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

async function handleLoans(subcommand: string | undefined): Promise<void> {
  switch (subcommand) {
    case "list":
    case undefined: {
      await runSelectedOrFanOut(async (client) => client.loans.list(), {
        jsonOnAggregate: true,
        renderSingle: (loans) => {
          if (loans.length === 0) {
            output("No items checked out.");
            return;
          }
          output(`\n  Checked out items (${loans.length}):\n`);
          for (const loan of loans) {
            const status =
              loan.dueStatus === "overdue"
                ? " [OVERDUE]"
                : loan.dueStatus === "due"
                  ? " [DUE SOON]"
                  : "";
            const renew = loan.renewable ? " (renewable)" : "";
            output(`  ${loan.title}`);
            output(`    Due: ${loan.dueDate}${status}${renew}`);
            if (loan.author) output(`    Author: ${loan.author}`);
            if (loan.id) output(`    ID: ${loan.id}`);
            output("");
          }
        },
      });
      break;
    }
    case "renew": {
      if (parsed.allProfiles) {
        console.error(
          "Error: loans renew is per-profile; pass --profile <selector> instead of --all-profiles.",
        );
        process.exit(1);
      }
      const targetId = positional[2];
      if (!targetId && !allFlag) {
        console.error("Usage: helmet loans renew <id> or helmet loans renew --all");
        process.exit(1);
      }
      const { client, persist } = await getAuthenticatedClient();
      let results: RenewalResult[];
      if (allFlag) {
        output("Renewing all items...");
        results = await client.loans.renewAll();
      } else {
        output(`Renewing item ${targetId}...`);
        results = await client.loans.renew(targetId!);
      }
      await persist();
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

async function handleHolds(
  subcommand: string | undefined,
  rest: string[],
): Promise<void> {
  switch (subcommand) {
    case "list":
    case undefined: {
      const { client, persist } = await getAuthenticatedClient();
      const holds = await client.holds.list();
      await persist();

      if (jsonFlag) {
        outputJson(holds);
      } else {
        if (holds.length === 0) {
          output("No holds.");
          return;
        }
        output(`\n  Holds (${holds.length}):\n`);
        for (const h of holds) {
          const statusLabel =
            h.status === "available_for_pickup"
              ? " [READY FOR PICKUP]"
              : h.status === "in_transit"
                ? " [IN TRANSIT]"
                : "";
          output(`  ${h.title}${statusLabel}`);
          if (h.author) output(`    Author: ${h.author}`);
          if (h.queuePosition != null) output(`    Queue position: ${h.queuePosition}`);
          if (h.pickupLocation) output(`    Pickup: ${h.pickupLocation}`);
          if (h.expirationDate) output(`    Expires: ${h.expirationDate}`);
          output("");
        }
      }
      break;
    }
    case "place": {
      const recordId = rest[0];
      if (!recordId) {
        console.error("Usage: helmet holds place <record-id> [--comment <text>]");
        process.exit(1);
      }
      const { client, persist } = await getAuthenticatedClient();
      const result = await client.holds.place(recordId, {
        comment: parsed.comment ?? undefined,
      });
      await persist();
      renderHoldActionResult(result, "place");
      if (!result.success) process.exit(1);
      break;
    }
    case "cancel": {
      const holdId = rest[0];
      if (!holdId) {
        console.error("Usage: helmet holds cancel <hold-id>");
        process.exit(1);
      }
      const { client, persist } = await getAuthenticatedClient();
      const result = await client.holds.cancel(holdId);
      await persist();
      renderHoldActionResult(result, "cancel");
      if (!result.success) process.exit(1);
      break;
    }
    default:
      console.error(`Unknown holds subcommand: ${subcommand}`);
      process.exit(1);
  }
}

function renderHoldActionResult(
  result: { success: boolean; message: string | null },
  verb: "place" | "cancel",
): void {
  if (jsonFlag) {
    outputJson(result);
    return;
  }
  const status = result.success ? "OK" : "FAILED";
  const msg = result.message ?? (result.success ? `Hold ${verb} submitted.` : `Hold ${verb} failed.`);
  output(`[${status}] ${msg}`);
}

async function handleFines(): Promise<void> {
  const { client, persist } = await getAuthenticatedClient();
  const { fines, total } = await client.fines.list();
  await persist();

  if (jsonFlag) {
    outputJson({ fines, total });
  } else {
    if (fines.length === 0) {
      output("No fines.");
      return;
    }
    output(`\n  Fines (${fines.length}):\n`);
    for (const f of fines) {
      output(`  ${f.title ?? "Unknown item"} — ${f.amount.toFixed(2)} ${f.currency}`);
      if (f.reason) output(`    Reason: ${f.reason}`);
      if (f.createDate) output(`    Date: ${f.createDate}`);
      output("");
    }
    output(`  Total: ${total.toFixed(2)} EUR\n`);
  }
}

async function handleSearch(query: string): Promise<void> {
  if (!query) {
    console.error("Usage: helmet search <query>");
    process.exit(1);
  }

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
      const buildings = (r.buildings ?? []) as Array<{ value: string; translated: string }>;
      const branches = buildings
        .filter((b) => b.value.startsWith("2/"))
        .map((b) => b.translated);
      output(`  ${r.title}`);
      if (r.primaryAuthor) output(`    Author: ${r.primaryAuthor}`);
      if (r.year) output(`    Year: ${r.year}`);
      if (branches.length > 0) output(`    Locations: ${branches.join(", ")}`);
      output(`    ID: ${r.id}`);
      output("");
    }
  }
}

async function handleSummary(): Promise<void> {
  await runSelectedOrFanOut(async (client) => client.summary.get(), {
    jsonOnAggregate: true,
    renderSingle: (summary) => {
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
      if (summary.holdsReady.length > 0) {
        output(`  READY FOR PICKUP: ${summary.holdsReady.length} item(s)!`);
        for (const h of summary.holdsReady) {
          output(`    - ${h.title}${h.pickupLocation ? ` (at ${h.pickupLocation})` : ""}`);
        }
      }
      if (summary.totalFines > 0) {
        output(`  Fines: ${summary.totalFines.toFixed(2)} EUR`);
        for (const f of summary.fines) {
          output(`    - ${f.title ?? "Unknown"}: ${f.amount.toFixed(2)} EUR`);
        }
      } else {
        output(`  Fines: 0 EUR`);
      }
      output("");
    },
  });
}

async function handleProfiles(
  subcommand: string | undefined,
  rest: string[],
): Promise<void> {
  const config = await loadConfig();

  switch (subcommand) {
    case "list":
    case undefined: {
      if (jsonFlag) {
        outputJson(
          config.profiles.map((p) => ({
            id: p.id,
            cardNumber: p.cardNumber,
            displayName: p.displayName ?? null,
            lastUsedAt: p.lastUsedAt,
          })),
        );
        return;
      }
      if (config.profiles.length === 0) {
        output("No profiles. Run: helmet login");
        return;
      }
      output(`\n  Profiles (${config.profiles.length}):\n`);
      for (const p of config.profiles) {
        const marker = p.id === config.lastProfileId ? " *" : "";
        output(`  ${p.displayName ?? "(unnamed)"}${marker}`);
        output(`    card: ${maskCardNumber(p.cardNumber)}`);
        output(`    last used: ${p.lastUsedAt}`);
        output("");
      }
      break;
    }
    case "remove": {
      const selector = rest[0];
      if (!selector) {
        console.error("Usage: helmet profiles remove <selector>");
        process.exit(1);
      }
      const result = resolveProfile(config, selector);
      if (!result.ok) {
        printResolveError(result);
        process.exit(1);
      }
      const target = result.profile;
      if (!jsonFlag) {
        const ok = await confirm({
          message: `Remove profile ${profileLabel(target)} (${maskCardNumber(target.cardNumber)})?`,
          default: false,
        });
        if (!ok) {
          output("Cancelled.");
          return;
        }
      }
      config.profiles = config.profiles.filter((p) => p.id !== target.id);
      if (config.lastProfileId === target.id) {
        config.lastProfileId = config.profiles[0]?.id ?? null;
      }
      await saveConfig(config);
      await clearSessionCache(target.id);
      if (jsonFlag) {
        outputJson({ ok: true, removed: target.id });
      } else {
        output(`Removed ${profileLabel(target)}.`);
      }
      break;
    }
    case "rename": {
      const selector = rest[0];
      const newName = rest.slice(1).join(" ").trim();
      if (!selector || !newName) {
        console.error("Usage: helmet profiles rename <selector> <new display name>");
        process.exit(1);
      }
      const result = resolveProfile(config, selector);
      if (!result.ok) {
        printResolveError(result);
        process.exit(1);
      }
      result.profile.displayName = newName;
      await saveConfig(config);
      if (jsonFlag) {
        outputJson({ ok: true, id: result.profile.id, displayName: newName });
      } else {
        output(`Renamed ${result.profile.id} → ${newName}.`);
      }
      break;
    }
    default:
      console.error(`Unknown profiles subcommand: ${subcommand}`);
      process.exit(1);
  }
}

async function handleInteractive(): Promise<void> {
  output("\n  Helmet Library CLI\n");

  const config = await loadConfig();
  let clients: { profile: StoredProfile; client: HelmetClient }[] = [];
  let fanOut = false;

  if (config.profiles.length === 0) {
    output("No saved profiles. Please log in first.\n");
    await handleLogin();
    const refreshed = await loadConfig();
    const first = refreshed.profiles[0];
    if (!first) return;
    clients = [{ profile: first, client: await loginAs(first) }];
  } else if (config.profiles.length === 1) {
    const p = config.profiles[0]!;
    clients = [{ profile: p, client: await loginAs(p) }];
  } else {
    const choices = [
      ...config.profiles.map((p) => ({
        name: `${p.displayName ?? "(unnamed)"} — ${maskCardNumber(p.cardNumber)}`,
        value: p.id,
      })),
      { name: "All profiles (fan-out)", value: "__all__" },
    ];
    const pick = await select({ message: "Choose profile:", choices });
    if (pick === "__all__") {
      fanOut = true;
      for (const p of config.profiles) {
        try {
          clients.push({ profile: p, client: await loginAs(p) });
        } catch (err) {
          console.error(`  [${profileLabel(p)}] login failed: ${errorMessage(err)}`);
        }
      }
    } else {
      const p = config.profiles.find((x) => x.id === pick)!;
      clients = [{ profile: p, client: await loginAs(p) }];
    }
  }

  if (clients.length === 0) {
    console.error("No authenticated profiles available.");
    process.exit(1);
  }

  while (true) {
    const action = await select({
      message: "What would you like to do?",
      choices: [
        { name: "View loans", value: "loans" },
        { name: "View holds", value: "holds" },
        { name: "View fines", value: "fines" },
        { name: "Renew all", value: "renew-all" },
        { name: "Search catalog", value: "search" },
        { name: "Summary", value: "summary" },
        { name: "Exit", value: "exit" },
      ],
    });

    if (action === "exit") return;
    if (action === "search") {
      const query = await input({ message: "Search for:" });
      if (query) await handleSearch(query);
      continue;
    }

    for (const { profile, client } of clients) {
      if (fanOut) output(`\n  === ${profileLabel(profile)} ===`);
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
        case "holds": {
          const holds = await client.holds.list();
          if (holds.length === 0) {
            output("  No holds.\n");
          } else {
            output(`\n  Holds (${holds.length}):\n`);
            for (const h of holds) {
              const status =
                h.status === "available_for_pickup"
                  ? " [READY]"
                  : h.status === "in_transit"
                    ? " [TRANSIT]"
                    : "";
              output(
                `  - ${h.title}${status}${h.pickupLocation ? ` (${h.pickupLocation})` : ""}`,
              );
            }
            output("");
          }
          break;
        }
        case "fines": {
          const { fines, total } = await client.fines.list();
          if (fines.length === 0) {
            output("  No fines.\n");
          } else {
            output(`\n  Fines (${fines.length}):\n`);
            for (const f of fines) {
              output(`  - ${f.title ?? "Unknown"}: ${f.amount.toFixed(2)} EUR`);
            }
            output(`  Total: ${total.toFixed(2)} EUR\n`);
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
        case "summary": {
          const summary = await client.summary.get();
          output(`  Total loans: ${summary.loans.length}`);
          if (summary.loansOverdue.length > 0) {
            output(`  OVERDUE: ${summary.loansOverdue.length} item(s)`);
          }
          if (summary.holdsReady.length > 0) {
            output(`  Ready for pickup: ${summary.holdsReady.length}`);
          }
          output(`  Fines: ${summary.totalFines.toFixed(2)} EUR\n`);
          break;
        }
      }
    }
  }
}

// ─── Multi-profile plumbing ─────────────────────────────────────

async function loginAs(profile: StoredProfile): Promise<HelmetClient> {
  const { client } = await authenticateProfile(profile);
  return client;
}

interface AuthenticatedProfile {
  client: HelmetClient;
  profile: StoredProfile;
  persist: () => Promise<void>;
}

/**
 * Load the cached session if present, otherwise perform a fresh login.
 * The returned `persist` saves the updated cookie jar back to the cache and
 * stamps lastUsedAt; call it after a successful command to keep the cache warm.
 */
async function authenticateProfile(
  profile: StoredProfile,
): Promise<AuthenticatedProfile> {
  const pin = revealSecret(profile.pinObfuscated);
  if (!pin) {
    throw new Error(
      `Could not decrypt PIN for ${profileLabel(profile)}. Re-login: helmet login`,
    );
  }
  const helmetProfile: HelmetProfile = {
    baseUrl: BASE_URL,
    cardNumber: profile.cardNumber,
    pin,
    debug: debugFlag,
  };

  const cached = await loadSessionCache(profile.id);
  const client = cached
    ? HelmetClient.resume(helmetProfile, cached)
    : await HelmetClient.login(helmetProfile);

  let persisted = false;
  const persist = async (): Promise<void> => {
    if (persisted) return;
    persisted = true;
    try {
      await saveSessionCache(profile.id, client.exportState());
    } catch {
      // Cache write is best-effort — never fail the command because of it.
    }
    const config = await loadConfig();
    const stored = config.profiles.find((p) => p.id === profile.id);
    if (stored) {
      stored.lastUsedAt = new Date().toISOString();
      config.lastProfileId = profile.id;
      await saveConfig(config);
    }
  };

  return { client, profile, persist };
}

async function resolveProfileOrExit(
  config: CliConfig,
  selector: string | null,
): Promise<StoredProfile> {
  if (selector) {
    const result = resolveProfile(config, selector);
    if (!result.ok) {
      printResolveError(result);
      process.exit(1);
    }
    return result.profile;
  }

  if (config.profiles.length === 0) {
    console.error("No profile available. Run: helmet login");
    process.exit(1);
  }
  if (config.profiles.length === 1) {
    return config.profiles[0]!;
  }
  const lastId = config.lastProfileId;
  return config.profiles.find((p) => p.id === lastId) ?? config.profiles[0]!;
}

function printResolveError(
  result: { ok: false; error: string; candidates?: StoredProfile[] },
): void {
  console.error(`Error: ${result.error}`);
  if (result.candidates && result.candidates.length > 0) {
    console.error("Candidates:");
    for (const c of result.candidates) {
      console.error(
        `  ${c.displayName ?? "(unnamed)"} — ${maskCardNumber(c.cardNumber)} — ${c.id}`,
      );
    }
  }
}

async function getAuthenticatedClient(): Promise<AuthenticatedProfile> {
  const config = await loadConfig();

  if (config.profiles.length === 0) {
    output("No saved profiles. Please log in first.\n");
    await handleLogin();
    const refreshed = await loadConfig();
    const p = refreshed.profiles[0];
    if (!p) {
      console.error("No profile available after login.");
      process.exit(1);
    }
    return authenticateOrExit(p);
  }

  const profile = await resolveProfileOrExit(config, parsed.profile);
  return authenticateOrExit(profile);
}

async function authenticateOrExit(
  profile: StoredProfile,
): Promise<AuthenticatedProfile> {
  try {
    return await authenticateProfile(profile);
  } catch (err) {
    if (err instanceof AuthenticationError) {
      // Stored credentials no longer work; drop any cache so next run starts fresh.
      await clearSessionCache(profile.id);
      console.error(`Authentication failed for ${profileLabel(profile)}: ${err.message}`);
      console.error("Try logging in again: helmet login");
      process.exit(1);
    }
    throw err;
  }
}

interface FanOutRow<T> {
  profile: { id: string; displayName: string | null; cardNumber: string };
  ok: boolean;
  data?: T;
  error?: string;
}

async function runSelectedOrFanOut<T>(
  run: (client: HelmetClient) => Promise<T>,
  opts: {
    jsonOnAggregate: boolean;
    renderSingle: (data: T) => void;
  },
): Promise<void> {
  if (!parsed.allProfiles) {
    const { client, persist } = await getAuthenticatedClient();
    const data = await run(client);
    await persist();
    if (jsonFlag) {
      outputJson(data);
    } else {
      opts.renderSingle(data);
    }
    return;
  }

  const config = await loadConfig();
  if (config.profiles.length === 0) {
    console.error("No profiles saved. Run: helmet login");
    process.exit(1);
  }

  const rows: FanOutRow<T>[] = [];
  let anyOk = false;

  for (const profile of config.profiles) {
    try {
      const { client, persist } = await authenticateProfile(profile);
      const data = await run(client);
      await persist();
      profile.lastUsedAt = new Date().toISOString();
      anyOk = true;
      rows.push({
        profile: {
          id: profile.id,
          displayName: profile.displayName ?? null,
          cardNumber: profile.cardNumber,
        },
        ok: true,
        data,
      });
    } catch (err) {
      const msg = errorMessage(err);
      rows.push({
        profile: {
          id: profile.id,
          displayName: profile.displayName ?? null,
          cardNumber: profile.cardNumber,
        },
        ok: false,
        error: msg,
      });
      if (!jsonFlag) {
        console.error(`[${profileLabel(profile)}] ${msg}`);
      }
    }
  }

  await saveConfig(config);

  if (jsonFlag) {
    // Redact raw cardNumber from JSON fan-out (use masked form).
    const redacted = rows.map((r) => ({
      profile: {
        id: r.profile.id,
        displayName: r.profile.displayName,
      },
      ok: r.ok,
      ...(r.ok ? { data: r.data } : { error: r.error }),
    }));
    outputJson(redacted);
  } else {
    for (const r of rows) {
      const label = r.profile.displayName ?? maskCardNumber(r.profile.cardNumber);
      output(`\n=== ${label} ===`);
      if (r.ok && r.data !== undefined) {
        opts.renderSingle(r.data);
      } else {
        output(`  (skipped: ${r.error})`);
      }
    }
  }

  if (!anyOk) process.exit(1);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

// ─── Output helpers ─────────────────────────────────────────────

function output(text: string): void {
  console.log(text);
}

function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function printUsage(): void {
  output(`
  helmet ${VERSION}

  Usage: helmet <command> [options]

  Commands:
    login                        Log in and save credentials
    loans list [--json]          List checked-out items
    loans renew <id> [--json]    Renew a specific item
    loans renew --all [--json]   Renew all renewable items
    holds list [--json]               List current holds
    holds place <record-id> [--comment <text>] Place a hold on a catalog record
    holds cancel <hold-id>            Cancel an existing hold
    fines [--json]               List fines and total
    search <query> [--json]      Search the catalog (unauthenticated)
    summary [--json]             Account summary
    profiles list [--json]       List saved profiles
    profiles remove <selector>   Remove a saved profile
    profiles rename <selector> <name>  Rename a profile's display name
    config path                  Show config file path
    version                      Print helmet version

  Profile options:
    --profile <selector>  Target one profile (id, card, or display name)
    --all-profiles        Fan out across all saved profiles (summary, loans list)

  Other options:
    --json    Output as JSON (for agents)
    --all     Apply to all items (loans renew)
    --debug   Show debug HTTP logs
    --version, -V  Print helmet version
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
