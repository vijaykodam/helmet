# Helmet CLI

A command-line interface for **Finland's Helmet library system** (Helsinki Metropolitan Area libraries). Check loans, renew books, view holds and fines — from your terminal or via AI agents.

## Install

```bash
npm install -g @helmet/cli
```

## Setup

```bash
helmet login
```

Enter your library card number and PIN when prompted. Credentials are saved locally at `~/.config/helmet/config.json`.

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
| `helmet config path` | Show config file location |

All commands accept `--json` for machine-readable output and `--debug` for HTTP logging.

## OpenClaw Skill

This repo ships as an [OpenClaw](https://github.com/anthropics/openclaw) skill, allowing AI agents to manage Helmet library accounts autonomously.

```bash
npx skills add vijaykodam/helmet
```

The skill provides triage guidance so agents prioritize overdue loans, fines, and ready-for-pickup holds.

## Packages

| Package | Description |
|---------|-------------|
| [`@helmet/client`](packages/helmet-client) | TypeScript client library for helmet.finna.fi |
| [`@helmet/cli`](packages/helmet-cli) | CLI built on top of @helmet/client |

## License

MIT
