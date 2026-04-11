import * as cheerio from "cheerio";
import type { Loan, RenewalResult } from "../types.js";

/**
 * Parse the /MyResearch/CheckedOut page HTML into structured Loan objects.
 *
 * Finna renders loans as <tr class="myresearch-row"> with 3 cells:
 *   1. Checkbox column (renewal IDs)
 *   2. Cover image
 *   3. Status info (.checkedout-status-information) containing:
 *      - .title-column: h3.record-title > a, span.authority-label (author),
 *        span.label.format-* (material type)
 *      - .status-column: <strong>Eräpäivä: dd.mm.yyyy</strong>,
 *        <strong>Uusittu: N</strong>
 *
 * Labels are in Finnish: Eräpäivä (due date), Uusittu (renewed),
 * Julkaisuvuosi (publication year), Viivakoodi (barcode).
 */
export function parseLoans(html: string): Loan[] {
  const $ = cheerio.load(html);
  const loans: Loan[] = [];
  const now = new Date();

  $("tr.myresearch-row").each((_i, el) => {
    const row = $(el);

    // Skip the header row (visually-hidden)
    if (row.hasClass("visually-hidden")) return;

    // Item ID from renewal checkbox
    const checkbox = row.find("input[name='renewSelectedIDS[]']");
    const id = checkbox.attr("value") ?? row.attr("id")?.replace("record", "") ?? "";

    // Title from h3.record-title > a
    const title = row.find("h3.record-title a").first().text().trim()
      || row.find(".record-title").first().text().trim()
      || "Unknown";

    // Author from span.authority-label
    const author = row.find("span.authority-label").first().text().trim() || null;

    // Material type from span.label.format-* (e.g., "Kirja", "DVD")
    const materialType = row.find("span[class*='format-']").first().text().trim() || null;

    // Parse <strong> tags in .status-column for labeled values
    // Pattern: <strong>Label: Value</strong> (label and value in same element)
    const statusColumn = row.find(".status-column");
    const strongTexts = extractStrongValues($, statusColumn);

    // Due date: "Eräpäivä: 11.5.2026" or "Förfallodag: 11.5.2026"
    const dueDate = strongTexts["eräpäivä"] ?? strongTexts["förfallodag"] ?? strongTexts["due date"] ?? "";

    // Renewal count: "Uusittu: 1"
    const renewText = strongTexts["uusittu"] ?? strongTexts["förnyelser"] ?? strongTexts["renewed"] ?? null;
    const renewals = renewText ? parseInt(renewText, 10) : null;

    // Borrowing location
    const borrowingLocation = strongTexts["lainauspaikka"] ?? strongTexts["lånebibliotek"] ?? strongTexts["borrowing location"] ?? null;

    // Checkout date
    const checkoutDate = strongTexts["lainauspäivä"] ?? strongTexts["lånedatum"] ?? strongTexts["checked out"] ?? null;

    // Publication year (bonus info from .title-column)
    const titleColumn = row.find(".title-column");
    const titleStrongs = extractStrongValues($, titleColumn);
    const _year = titleStrongs["julkaisuvuosi"] ?? null;

    // Renewable: has a renewal checkbox
    const renewable = checkbox.length > 0;

    // Due status from alert classes
    let dueStatus: "overdue" | "due" | "ok" = "ok";
    if (row.find(".alert-danger").length > 0 || statusColumn.find(".text-danger").length > 0) {
      dueStatus = "overdue";
    } else if (row.find(".alert-warning").length > 0) {
      dueStatus = "due";
    }

    if (id || title !== "Unknown") {
      loans.push({
        id,
        title,
        author,
        dueDate,
        checkoutDate,
        renewable,
        renewals: isNaN(renewals ?? NaN) ? null : renewals,
        materialType,
        borrowingLocation: borrowingLocation || null,
        dueStatus,
        fetchedAt: now,
      });
    }
  });

  return loans;
}

/**
 * Extract all <strong>Label: Value</strong> pairs from a container.
 * Finna puts label and value in the same <strong> element:
 *   <strong>Eräpäivä: 11.5.2026</strong>
 *   <strong>Uusittu: 1</strong>
 * Returns a map of lowercase label → value.
 */
function extractStrongValues(
  $: cheerio.CheerioAPI,
  container: ReturnType<cheerio.CheerioAPI>,
): Record<string, string> {
  const values: Record<string, string> = {};

  container.find("strong").each((_i, el) => {
    const text = $(el).text().trim();
    const colonIdx = text.indexOf(":");
    if (colonIdx > 0) {
      const label = text.slice(0, colonIdx).trim().toLowerCase();
      const value = text.slice(colonIdx + 1).trim();
      if (label && value) {
        values[label] = value;
      }
    }
  });

  return values;
}

/**
 * Known Finna renewal error patterns mapped to structured codes.
 * The keys are substrings found in Finnish error detail messages.
 */
const RENEWAL_ERROR_PATTERNS: Record<string, string> = {
  "liian pian": "RENEWED_TOO_SOON",
  "too soon": "RENEWED_TOO_SOON",
  "för tidigt": "RENEWED_TOO_SOON",
  "uusintaraja": "RENEWAL_LIMIT_REACHED",
  "renewal limit": "RENEWAL_LIMIT_REACHED",
  "varattu": "ITEM_ON_HOLD",
  "on hold": "ITEM_ON_HOLD",
  "reserverad": "ITEM_ON_HOLD",
  "ei voitu uusia": "RENEWAL_NOT_ALLOWED",
  "cannot be renewed": "RENEWAL_NOT_ALLOWED",
};

/**
 * Parse renewal response HTML. After POSTing a renewal form, Finna returns
 * the same page with flash messages (success/failure) plus the updated loan table.
 *
 * Finna emits multiple flash messages per renewal attempt:
 *   - Summary: "Yhden uusiminen epäonnistui." / "Laina uusittu."
 *   - Count:   "1 lainan uusinta epäonnistui."
 *   - Detail:  "Lainaa ei voitu uusia: UUSITAAN LIIAN PIAN"
 *
 * This parser consolidates them into one RenewalResult per submitted item ID.
 * If item IDs aren't provided (legacy call), it returns a single consolidated result.
 */
export function parseRenewalResults(
  html: string,
  submittedIds?: string[],
): RenewalResult[] {
  const $ = cheerio.load(html);

  // Collect all flash messages, categorized
  const successMessages: string[] = [];
  const failureMessages: string[] = [];

  $(".alert-success, .alert-danger, .renewal-status").each((_i, el) => {
    const msg = $(el);
    const text = msg.text().trim();
    if (!text) return;

    if (
      msg.hasClass("alert-success") ||
      text.toLowerCase().includes("uusittu") ||
      text.toLowerCase().includes("renewed") ||
      text.toLowerCase().includes("förnyad")
    ) {
      successMessages.push(text);
    } else if (msg.hasClass("alert-danger")) {
      failureMessages.push(text);
    }
  });

  // Extract structured error code from detail messages
  const allFailureText = failureMessages.join(" ").toLowerCase();
  let errorCode: string | null = null;
  for (const [pattern, code] of Object.entries(RENEWAL_ERROR_PATTERNS)) {
    if (allFailureText.includes(pattern)) {
      errorCode = code;
      break;
    }
  }

  // Find the most specific failure message (the one with ":" detail, not the summary/count)
  const detailMessage =
    failureMessages.find((m) => m.includes(":")) ??
    failureMessages[failureMessages.length - 1] ??
    null;

  const detailSuccessMessage =
    successMessages.find((m) => m.includes(":")) ??
    successMessages[successMessages.length - 1] ??
    null;

  // Determine overall success: any success message and no failure messages
  const hasSuccess = successMessages.length > 0;
  const hasFailure = failureMessages.length > 0;

  // Try to extract new due dates from the updated loan table for successful renewals
  const newDueDates = new Map<string, string>();
  if (hasSuccess && submittedIds?.length) {
    const updatedLoans = parseLoans(html);
    for (const loan of updatedLoans) {
      if (submittedIds.includes(loan.id) && loan.dueDate) {
        newDueDates.set(loan.id, loan.dueDate);
      }
    }
  }

  // Build results: one per submitted ID
  if (submittedIds?.length) {
    return submittedIds.map((id): RenewalResult => {
      // For single-item renewal, all messages apply to that item
      // For multi-item, we can't always distinguish per-item — attribute overall status
      const itemSuccess = hasSuccess && !hasFailure
        ? true
        : !hasFailure
          ? true  // no messages at all — assume ok
          : submittedIds.length === 1
            ? !hasFailure  // single item: failure messages mean this item failed
            : hasSuccess && !hasFailure; // multi: conservative

      return {
        id,
        success: itemSuccess,
        newDueDate: newDueDates.get(id) ?? null,
        message: itemSuccess
          ? detailSuccessMessage
          : detailMessage,
        errorCode: itemSuccess ? null : errorCode,
      };
    });
  }

  // Fallback: no IDs provided — return single consolidated result
  const success = hasSuccess && !hasFailure;
  return [{
    id: "",
    success,
    newDueDate: null,
    message: success ? detailSuccessMessage : detailMessage,
    errorCode: success ? null : errorCode,
  }];
}

/**
 * Extract CSRF token from the checked-out page for renewal forms.
 */
export function extractRenewalCsrf(html: string): string | null {
  const $ = cheerio.load(html);
  const csrf = $("form[name='renewals'] input[name='csrf']").attr("value")
    ?? $("input[name='csrf']").first().attr("value")
    ?? null;
  return csrf;
}
