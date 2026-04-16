---
"@helmet-ai/helmet": minor
---

holds: rename `expirationDate` to `pickupDeadline` and add `shelfLocation`, `createdDate` fields. Fixes a parser bug where the creation date was mislabeled as the expiration date. Text output now shows `Shelf`, `Pickup by`, and `Created` lines.
