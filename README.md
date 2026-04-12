# Helmet CLI

A command-line interface for **Finland's Helmet library system** (Helsinki Metropolitan Area libraries). Check loans, renew books, view holds and fines — from your terminal or via AI agents.

## Install

```bash
npm install -g @helmet-ai/helmet
```

## Setup

```bash
helmet login
```

Enter your library card number and PIN when prompted. You can also set an optional display name (e.g. `Alice`) which makes multi-profile commands much more ergonomic. Credentials are saved locally at `~/.config/helmet/config.json`. Run `helmet login` once per card to register additional family members.

## Commands

| Command | Description |
|---------|-------------|
| `helmet summary` | Full account overview |
| `helmet loans list` | List checked-out items |
| `helmet loans renew <id>` | Renew a specific item |
| `helmet loans renew --all` | Renew all renewable items |
| `helmet holds` | List current holds |
| `helmet fines` | List fines and total |
| `helmet search <query>` | Search the Helmet catalog |
| `helmet profiles list` | List saved profiles |
| `helmet profiles rename <selector> <name>` | Rename a profile's display name |
| `helmet profiles remove <selector>` | Remove a saved profile |
| `helmet config path` | Show config file location |

All commands accept `--json` for machine-readable output and `--debug` for HTTP logging.

## Multiple profiles (family accounts)

Save several library cards and target them individually or all at once.

```bash
helmet login                                  # run once per card
helmet profiles list                          # see saved profiles

helmet summary --profile Alice --json         # one profile (by display name)
helmet summary --profile 1234567890 --json    # one profile (by card number)
helmet summary --all-profiles --json          # fan out across all profiles
helmet loans list --all-profiles --json       # every family member's loans
```

### Flags

| Flag | Purpose |
|------|---------|
| `--profile <selector>` | Target one profile. Selector = display name (or unique prefix), card number, or id (`helmet\|<card>`). |
| `--all-profiles` | Run the command once per saved profile and aggregate. Supported on `summary` and `loans list`. Mutually exclusive with `--profile`. |

### Fan-out JSON shape

`--all-profiles --json` wraps results in a per-profile array. One profile failing does not block the others; exit code is `0` if any succeeded.

```json
[
  {"profile": {"id": "helmet|...", "displayName": "Alice"}, "ok": true,  "data": { /* same shape as single --json */ }},
  {"profile": {"id": "helmet|...", "displayName": "Bob"},   "ok": false, "error": "AuthenticationError: ..."}
]
```

`loans renew` is intentionally **not** fan-out-able — it requires `--profile <selector>` when multiple profiles exist, to prevent accidental family-wide mutations.

## OpenClaw Skill

This repo ships as an [OpenClaw](https://github.com/anthropics/openclaw) skill, allowing AI agents to manage Helmet library accounts autonomously.

```bash
npx skills add vijaykodam/helmet
```

The skill provides triage guidance so agents prioritize overdue loans, fines, and ready-for-pickup holds.

## Library usage

The same package exposes a TypeScript client you can import:

```ts
import { HelmetClient } from "@helmet-ai/helmet";

const client = new HelmetClient({ baseUrl: "https://helmet.finna.fi" });
await client.login({ cardNumber: "...", pin: "..." });
const loans = await client.getLoans();
```

## License

MIT
