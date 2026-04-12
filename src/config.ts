import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { SessionState } from "./session.js";

export interface StoredProfile {
  id: string;
  cardNumber: string;
  pinObfuscated: string;
  displayName?: string | null;
  lastUsedAt: string;
}

export interface CliConfig {
  profiles: StoredProfile[];
  lastProfileId?: string | null;
}

const SALT = "helmet::";

export function getConfigPath(): string {
  const override = process.env.HELMET_CONFIG_PATH;
  if (override) {
    return resolve(override);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? resolve(xdg) : resolve(homedir(), ".config");
  return resolve(base, "helmet", "config.json");
}

export async function loadConfig(): Promise<CliConfig> {
  const path = getConfigPath();
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw) as CliConfig;
    if (!data.profiles) {
      return { profiles: [] };
    }
    return data;
  } catch {
    return { profiles: [] };
  }
}

export async function saveConfig(config: CliConfig): Promise<void> {
  const path = getConfigPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function obfuscateSecret(value: string): string {
  return Buffer.from(SALT + value, "utf-8").toString("base64");
}

export function revealSecret(value: string): string | null {
  try {
    const decoded = Buffer.from(value, "base64").toString("utf-8");
    if (!decoded.startsWith(SALT)) {
      return null;
    }
    return decoded.slice(SALT.length);
  } catch {
    return null;
  }
}

// ─── Session cache ─────────────────────────────────────────────
// Persists authenticated cookie jars so a fresh CLI run can skip the full
// Finna login handshake. The cache file holds cookies + the PIN, which is
// no more sensitive than config.json (already stores the obfuscated PIN).
// Mode 0600, directory 0700, same posture as saveConfig.

export function getSessionCachePath(id: string): string {
  return resolve(dirname(getConfigPath()), "sessions", `${id}.json`);
}

export async function loadSessionCache(id: string): Promise<SessionState | null> {
  try {
    const raw = await readFile(getSessionCachePath(id), "utf-8");
    const data = JSON.parse(raw) as SessionState;
    if (data.version !== 1 || !data.cookies || !data.cardNumber || !data.pin) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export async function saveSessionCache(
  id: string,
  state: SessionState,
): Promise<void> {
  const path = getSessionCachePath(id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(state) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export async function clearSessionCache(id: string): Promise<void> {
  try {
    await unlink(getSessionCachePath(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

export function profileId(cardNumber: string): string {
  return `helmet|${cardNumber}`;
}

export function maskCardNumber(cardNumber: string): string {
  const last4 = cardNumber.slice(-4);
  return `****${last4}`;
}

export function profileLabel(profile: StoredProfile): string {
  return profile.displayName ?? maskCardNumber(profile.cardNumber);
}

export type ResolveProfileResult =
  | { ok: true; profile: StoredProfile }
  | { ok: false; error: string; candidates?: StoredProfile[] };

export function resolveProfile(
  config: CliConfig,
  selector: string,
): ResolveProfileResult {
  const profiles = config.profiles;
  if (profiles.length === 0) {
    return { ok: false, error: "No profiles saved. Run: helmet login" };
  }

  // 1. Exact id match
  const byId = profiles.find((p) => p.id === selector);
  if (byId) return { ok: true, profile: byId };

  // 2. Exact cardNumber match
  const byCard = profiles.find((p) => p.cardNumber === selector);
  if (byCard) return { ok: true, profile: byCard };

  const lower = selector.toLowerCase();

  // 3. Case-insensitive exact displayName match
  const byNameExact = profiles.filter(
    (p) => p.displayName != null && p.displayName.toLowerCase() === lower,
  );
  if (byNameExact.length === 1) return { ok: true, profile: byNameExact[0]! };
  if (byNameExact.length > 1) {
    return {
      ok: false,
      error: `Ambiguous profile selector "${selector}" — multiple profiles share this display name.`,
      candidates: byNameExact,
    };
  }

  // 4. Case-insensitive prefix match on displayName
  const byNamePrefix = profiles.filter(
    (p) => p.displayName != null && p.displayName.toLowerCase().startsWith(lower),
  );
  if (byNamePrefix.length === 1) return { ok: true, profile: byNamePrefix[0]! };
  if (byNamePrefix.length > 1) {
    return {
      ok: false,
      error: `Ambiguous profile selector "${selector}" — matches multiple profiles.`,
      candidates: byNamePrefix,
    };
  }

  return {
    ok: false,
    error: `No profile matches "${selector}".`,
    candidates: profiles,
  };
}
