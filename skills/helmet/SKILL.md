---
name: helmet
version: 0.1.0
description: Access Finland's Helmet library system from AI agents. Check loans, renew books, place/cancel holds, and view fines for one or many family accounts via the helmet CLI. Session cookies are cached between invocations so warm calls skip the login handshake. Start with `helmet summary --json` for one account, or `helmet summary --all-profiles --json` to cover the whole family.
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
        package: "@helmet-ai/helmet"
        bins:
          - helmet
        label: Install Helmet CLI (npm)
    credentials:
      note: >-
        Requires ~/.config/helmet/config.json created by running
        `helmet login` interactively once per library card. Stores library
        card number and PIN for each saved profile.
---

# Helmet Library Skill

Access the **Helmet library system** (Helsinki Metropolitan Area libraries) from an AI agent. Query loans, renew books, check holds and fines — for one account or many family accounts at once, via the `helmet` CLI with `--json` output.

## Quick Start

```bash
# Install
npm install -g @helmet-ai/helmet

# First-time login — run once per library card (saves credentials locally)
helmet login

# Full account overview (single account)
helmet summary --json

# Family overview (all saved profiles)
helmet summary --all-profiles --json
```

## Profiles

The CLI stores one or more library accounts as *profiles*. Use these when acting for a user or a family:

- **One profile saved** — commands run against it by default.
- **Multiple profiles saved** — commands run against the last-used profile unless you pass `--profile` or `--all-profiles`.

### Profile selection flags

| Flag | Purpose |
|------|---------|
| `--profile <selector>` | Target one profile. Selector is any of: display name (`Alice`), unique display-name prefix (`al`), card number, or full id (`helmet\|<card>`). |
| `--all-profiles` | Fan out across every saved profile. Works on `summary` and `loans list`. Mutually exclusive with `--profile`. |

`--all-profiles` is **not** supported on `loans renew`, `holds place`, `holds cancel` (all destructive — always target one profile), `search` (unauthenticated), or `login`.

### Fan-out JSON shape

`--all-profiles --json` wraps output in a per-profile array. Each row is independent: one profile failing does not block others.

```json
[
  {"profile": {"id": "helmet|...", "displayName": "Alice"}, "ok": true,  "data": { /* same shape as single-profile --json */ }},
  {"profile": {"id": "helmet|...", "displayName": "Bob"},   "ok": false, "error": "AuthenticationError: ..."}
]
```

Exit code is `0` if at least one profile succeeded, `1` if all failed.

### `helmet profiles list --json`

Enumerate saved profiles. Returns `id`, `displayName`, `cardNumber`, and `lastUsedAt` for each.

### `helmet profiles rename <selector> <new-name>` / `helmet profiles remove <selector>`

Local-only management of saved profiles (no Helmet API calls).

## Session cache

Each profile's authenticated cookie jar is persisted at `~/.config/helmet/sessions/<id>.json` (mode 0600). The first command per profile walks the full Finna login handshake (~2.7s); subsequent commands skip straight to the data request (~1.3s). Stale cookies are handled transparently — if Finna redirects to the login page, the session auto-re-authenticates using the stored PIN. You do not need to manage the cache explicitly; it is cleared automatically on `helmet login`, `helmet profiles remove`, or an unrecoverable `AuthenticationError`.

## Commands

All commands accept `--json` for machine-readable output. Always use `--json` when calling from an agent.

### `helmet summary --json`

Returns a complete account snapshot: loans (with overdue/due-soon flags), holds (with pickup-ready status), and fines. **Start here** — one call gives you everything needed for triage. Add `--profile <selector>` for a specific person or `--all-profiles` for a whole family.

### `helmet loans list --json`

List checked-out items with title, author, due date, due status (`ok`, `due`, `overdue`), and whether renewable. Supports `--profile` and `--all-profiles`.

### `helmet loans renew <id> --json`

Renew a specific loan by its ID. Returns success/failure with new due date or error code. **Requires** `--profile <selector>` when multiple profiles exist (the CLI will not auto-pick a profile for destructive operations).

### `helmet loans renew --all --json`

Renew every renewable item on one profile. Same profile-targeting rule as above — pass `--profile <selector>` explicitly.

### `helmet holds list --json`

List current holds (status: `pending`, `in_transit`, `available_for_pickup`), queue position, pickup location, expiration date. `helmet holds` (no subcommand) is an alias.

### `helmet holds place <record-id> [--pickup <location>] [--comment <text>] --json`

Place a title-level hold on a Helmet catalog record. The `record-id` comes from `helmet search` (e.g. `helmet.2613471`). Pickup defaults to the user's preferred branch; override with `--pickup <code>` (branch code like `e71al`, not a display name). The `--comment` field is used only for bookmobile pickup stops. Returns `{ success, message }`; on success, message is typically `"Varauspyyntö onnistui."`. **Requires** `--profile <selector>` when multiple profiles exist — the CLI will not auto-pick a profile for a destructive/state-changing operation.

### `helmet holds cancel <hold-id> --json`

Cancel an active hold. The `hold-id` is the `id` field from `helmet holds list --json`. Returns `{ success, message }`; on success, message is typically `"1 varaus(ta) poistettu."`. Same profile-targeting rule as `place` — pass `--profile <selector>` explicitly.

### `helmet fines --json`

List individual fines and total amount owed.

### `helmet search <query> --json`

Search the Helmet catalog. Unauthenticated — `--profile` has no effect and `--all-profiles` is rejected.

### `helmet version` / `helmet --version` / `helmet -V`

Print the CLI version (e.g. `0.1.0`). No auth, no network. Useful when an agent needs to record which helmet build produced a report.

## Triage Guidance

When reporting to the user, prioritize items by actionability:

| Priority | Condition | Action |
|----------|-----------|--------|
| URGENT | Overdue items (`dueStatus: "overdue"`) | Renew immediately or alert user |
| URGENT | Fines > 0 EUR | Alert user — fines block borrowing |
| HIGH | Loans due within 3 days (`dueStatus: "due"` or in `loansDueSoon`) | Renew if possible, otherwise warn |
| HIGH | Holds ready for pickup (`status: "available_for_pickup"`) | Alert user — pickup window is limited |
| MEDIUM | Loans due within 7 days | Mention in summary |
| LOW | Holds with queue position ≤ 2 | Mention — pickup may come soon |

### Recommended workflow (single person)

1. Run `helmet summary --json` (or with `--profile <name>`).
2. Check for URGENT items first — auto-renew overdue loans if renewable.
3. Surface HIGH items prominently.
4. Mention MEDIUM/LOW items briefly.
5. If renewals fail, include the error code in your report.

### Recommended workflow (family)

1. Run `helmet summary --all-profiles --json` — one call covers everyone.
2. Flatten rows where `ok: true`. For each `ok: false` row, mention the person's name and that their data could not be fetched (don't abort the whole report).
3. Group findings **by urgency first, by person second** — one overdue book across any family member is more actionable than "here is Alice's summary, here is Bob's summary".
4. For renewals, issue one `helmet loans renew --all --profile <name>` per person that has renewable overdue loans. **Never fan out renew.**
5. Prefer referring to people by `displayName` in user-facing output; keep `id` for internal routing.

## Scripts

The wrapper script at `scripts/helmet-cli.sh` can be used as a fallback when the `helmet` binary is not on PATH:

```bash
bash skills/helmet/scripts/helmet-cli.sh summary --all-profiles --json
```
