---
name: helmet
version: 0.1.0
description: Access Finland's Helmet library system from AI agents. Check loans, renew books, view holds and fines via the helmet CLI. Start with `helmet summary --json` for a full account overview.
metadata:
  openclaw:
    requires:
      bins:
        - helmet
      configPaths:
        - ~/.config/helmet/config.json
    install:
      - id: node
        kind: node
        package: "@helmet/cli"
        bins:
          - helmet
        label: Install Helmet CLI (npm)
    credentials:
      note: >-
        Requires ~/.config/helmet/config.json created by running
        `helmet login` interactively once. Stores library card number and PIN.
---

# Helmet Library Skill

Access the **Helmet library system** (Helsinki Metropolitan Area libraries) from an AI agent. Query loans, renew books, check holds and fines — all via the `helmet` CLI with `--json` output.

## Quick Start

```bash
# Install
npm install -g @helmet/cli

# First-time login (interactive — saves credentials locally)
helmet login

# Full account overview
helmet summary --json
```

## Commands

All commands accept `--json` for machine-readable output. Always use `--json` when calling from an agent.

### `helmet summary --json`

Returns a complete account snapshot: loans (with overdue/due-soon flags), holds (with pickup-ready status), and fines. **Start here** — one call gives you everything needed for triage.

### `helmet loans list --json`

List all checked-out items with title, author, due date, due status (`ok`, `due`, `overdue`), and whether the item is renewable.

### `helmet loans renew <id> --json`

Renew a specific loan by its ID. Returns success/failure with new due date or error code.

### `helmet loans renew --all --json`

Renew all renewable items at once. Returns per-item results.

### `helmet holds --json`

List current holds with status (`waiting`, `in_transit`, `available_for_pickup`), queue position, pickup location, and expiration date.

### `helmet fines --json`

List individual fines and total amount owed.

### `helmet search <query> --json`

Search the Helmet catalog. Does not require authentication. Returns up to 20 results with title, author, year, and ID.

## Triage Guidance

When reporting to the user, prioritize items by actionability:

| Priority | Condition | Action |
|----------|-----------|--------|
| URGENT | Overdue items (`dueStatus: "overdue"`) | Renew immediately or alert user |
| URGENT | Fines > 0 EUR | Alert user — fines block borrowing |
| HIGH | Loans due within 3 days (`dueStatus: "due"` or in `loansDueSoon`) | Renew if possible, otherwise warn |
| HIGH | Holds ready for pickup (`status: "available_for_pickup"`) | Alert user — pickup window is limited |
| MEDIUM | Loans due within 7 days | Mention in summary |
| LOW | Holds with queue position <= 2 | Mention — pickup may come soon |

### Recommended workflow

1. Run `helmet summary --json`
2. Check for URGENT items first — auto-renew overdue loans if renewable
3. Surface HIGH items prominently
4. Mention MEDIUM/LOW items briefly
5. If renewals fail, include the error code in your report

## Scripts

The wrapper script at `scripts/helmet-cli.sh` can be used as a fallback when the `helmet` binary is not on PATH:

```bash
bash skills/helmet/scripts/helmet-cli.sh summary --json
```
