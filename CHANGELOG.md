# @helmet-ai/helmet

## 0.3.0

### Minor Changes

- holds: parser now surfaces the pickup deadline, shelf location, and created date for every hold.
  - Renamed `Hold.expirationDate` → `Hold.pickupDeadline` (extracted from the Finnish "nouto viimeistään DD.MM.YYYY" text inside the ready-for-pickup alert).
  - Added `Hold.shelfLocation` (from "Varaushylly: …", shown for arrived holds).
  - Added `Hold.createdDate` (from "Luotu: …", shown on every hold).
  - Fixed a parser bug where `expirationDate` fell back to the hold's creation date — users saw "Expires: <date>" where `<date>` was actually when the hold was placed. The new fields carry the correct semantics, and `pickupDeadline` is `null` until the hold arrives at the branch.
  - `helmet holds` text output now includes `Shelf`, `Pickup by`, and `Created` lines.
  - `deriveHoldStatus` now recognizes Finnish "Matkalla noutopaikkaan" (and Swedish "på väg") as `in_transit`; previously these fell through to `pending`.
  - SKILL.md: documented the full Hold JSON shape and added triage rules so agents flag arrived holds as URGENT when `pickupDeadline` is imminent, and include shelf location + deadline in pickup reminders so the user avoids the no-pickup fee.
  - **Breaking JSON change** for consumers of `helmet holds --json` that read `expirationDate`. Rename to `pickupDeadline` when upgrading.

## 0.2.0

### Minor Changes

- e77a229: Fix silent authentication failures. Previously, `loans list`, `holds list`, `fines`, `summary`, and renewals would return empty arrays when the stored session had expired — because Finna serves the login page with HTTP 200 (not a redirect) and the CLI parsed it as "no data". The CLI now detects the login page in any authenticated response, attempts one transparent re-auth with the stored PIN, and on failure exits with code 2 and `{"ok": false, "errorCode": "AUTH_REQUIRED", ...}` in `--json` mode.

  New command: `helmet status [--json] [--all-profiles]` — a lightweight preflight that reports whether saved sessions are live. Exit 0 if authenticated, 2 if `helmet login` is needed.

## 0.1.1

### Patch Changes

- Remove the unsupported `--pickup` option from the holds command.
