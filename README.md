# Helmet CLI

A command-line interface for **Finland's Helmet library system** (Helsinki Metropolitan Area libraries). Check loans, renew books, view holds and fines, from your terminal or via AI agents.

## Install

```bash
npm install -g @helmet-ai/helmet
```

## Setup

```bash
helmet login
```

Enter your library card number and PIN when prompted. You can also set an optional display name (e.g. `Petri`) which makes multi-profile commands much more ergonomic. Credentials are saved locally at `~/.config/helmet/config.json` and the authenticated cookie jar is cached per-profile at `~/.config/helmet/sessions/<id>.json` (both mode 0600) so subsequent commands skip the full login handshake. Run `helmet login` once per card to register additional family members.

## Commands

| Command | Description |
|---------|-------------|
| `helmet` | Interactive mode: choose a profile (or all profiles), then an action from a menu |
| `helmet login` | Save a library card (card number, PIN, optional display name) |
| `helmet status` | Check that the saved session works. Exit code `0` if logged in, `2` if `helmet login` is needed |
| `helmet summary` | Full account overview |
| `helmet loans list` | List checked-out items |
| `helmet loans renew <id>` | Renew a specific item |
| `helmet loans renew --all` | Renew all renewable items |
| `helmet holds list` | List current holds with pickup deadline, shelf location, and queue position |
| `helmet holds place <record-id>` | Place a hold on a catalog record (uses the default pickup location from the hold form; optional `--comment <text>` for bookmobile stops) |
| `helmet holds cancel <hold-id>` | Cancel an active hold |
| `helmet fines` | List fines and total |
| `helmet search <query>` | Search the Helmet catalog (no login needed) |
| `helmet profiles list` | List saved profiles |
| `helmet profiles rename <selector> <name>` | Rename a profile's display name |
| `helmet profiles remove <selector>` | Remove a saved profile |
| `helmet config path` | Show config file location |
| `helmet version` | Print CLI version (also `helmet --version` / `-V`) |

All commands accept `--json` for machine-readable output and `--debug` for HTTP logging.

## Multiple profiles (family accounts)

Save several library cards and target them individually or all at once.

```bash
helmet login                                  # run once per card
helmet profiles list                          # see saved profiles

helmet summary --profile Petri --json         # one profile (by display name)
helmet summary --profile 1234567890 --json    # one profile (by card number)
helmet summary --all-profiles --json          # fan out across all profiles
helmet loans list --all-profiles --json       # every family member's loans
```

### Flags

| Flag | Purpose |
|------|---------|
| `--profile <selector>` | Target one profile. Selector = display name (or unique prefix), card number, or id (`helmet\|<card>`). |
| `--all-profiles` | Run the command once per saved profile and aggregate. Supported on `summary`, `loans list`, and `status`. Mutually exclusive with `--profile`. |

### Fan-out JSON shape

`--all-profiles --json` wraps results in a per-profile array. One profile failing does not block the others; exit code is `0` if any succeeded. Card numbers in the output are masked. A failed login has `"errorCode": "AUTH_REQUIRED"`, which means that profile needs `helmet login`.

```json
[
  {"profile": {"id": "helmet|...", "displayName": "Petri", "cardNumber": "****7890"}, "ok": true,  "data": { /* same shape as single --json */ }},
  {"profile": {"id": "helmet|...", "displayName": "Janne", "cardNumber": "****1234"}, "ok": false, "error": "AuthenticationError: ...", "errorCode": "AUTH_REQUIRED"}
]
```

`helmet status --all-profiles --json` uses a different shape: `{ "version", "checkedAt", "profiles": [...] }`, with `authenticated` set for each profile.

`loans renew` is intentionally **not** fan-out-able. It requires `--profile <selector>` when multiple profiles exist, to prevent accidental family-wide mutations.

## OpenClaw Skill

This repo ships an [OpenClaw](https://openclaw.ai) skill that lets AI agents manage Helmet library accounts. The skill is published on ClawHub: [clawhub.ai/vijaykodam/skills/helmet](https://clawhub.ai/vijaykodam/skills/helmet).

To install the skill from this repo with the `skills` CLI:

```bash
npx skills add vijaykodam/helmet
```

The skill provides triage guidance so agents prioritize overdue loans, fines, and ready-for-pickup holds.

## Claude Code Plugin

The same skill is available as a Claude Code plugin from [vijaykodam/helmet-claude-plugin](https://github.com/vijaykodam/helmet-claude-plugin). Install the `helmet` CLI first (see [Install](#install)), then run these commands in Claude Code:

```
/plugin marketplace add vijaykodam/helmet-claude-plugin
/plugin install helmet@helmet
```

## Library usage

The same package exposes a TypeScript client you can import:

```ts
import { HelmetClient, AuthenticationError } from "@helmet-ai/helmet";

const client = await HelmetClient.login({
  baseUrl: "https://helmet.finna.fi",
  cardNumber: "...",
  pin: "...",
}); // throws AuthenticationError on a wrong card number or PIN

const loans = await client.loans.list();
const holds = await client.holds.list();
const { fines, total } = await client.fines.list();
```

## License

MIT
