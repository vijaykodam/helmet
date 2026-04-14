---
"@helmet-ai/helmet": minor
---

Fix silent authentication failures. Previously, `loans list`, `holds list`, `fines`, `summary`, and renewals would return empty arrays when the stored session had expired — because Finna serves the login page with HTTP 200 (not a redirect) and the CLI parsed it as "no data". The CLI now detects the login page in any authenticated response, attempts one transparent re-auth with the stored PIN, and on failure exits with code 2 and `{"ok": false, "errorCode": "AUTH_REQUIRED", ...}` in `--json` mode.

New command: `helmet status [--json] [--all-profiles]` — a lightweight preflight that reports whether saved sessions are live. Exit 0 if authenticated, 2 if `helmet login` is needed.
