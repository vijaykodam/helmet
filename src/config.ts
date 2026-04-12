import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

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

export function profileId(cardNumber: string): string {
  return `helmet|${cardNumber}`;
}
