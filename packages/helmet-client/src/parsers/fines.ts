import * as cheerio from "cheerio";
import type { Fine } from "../types.js";
import { extractStrongValues } from "./utils.js";

/**
 * Parse the /MyResearch/Fines page HTML into structured Fine objects.
 *
 * Finna's fines page uses a table structure with rows per fine item.
 * Each row may contain the title, amount (with €), reason, and date.
 *
 * Labels are in Finnish: Summa (amount), Syy (reason), Päivämäärä (date).
 */
export function parseFines(html: string): { fines: Fine[]; total: number } {
  const $ = cheerio.load(html);
  const fines: Fine[] = [];
  const now = new Date();

  $("tr.myresearch-row").each((i, el) => {
    const row = $(el);

    if (row.hasClass("visually-hidden")) return;

    const id = row.attr("id")?.replace("record", "") ?? String(i);

    // Title from .record-title or first text cell
    const title = row.find(".record-title a").first().text().trim()
      || row.find(".record-title").first().text().trim()
      || null;

    // Parse <strong> tags for labeled values
    const statusColumn = row.find(".status-column");
    const strongTexts = extractStrongValues($, statusColumn);

    // Amount: "Summa" / "Belopp" / "Amount", or look for € in the row
    const amountText =
      strongTexts["summa"] ??
      strongTexts["belopp"] ??
      strongTexts["amount"] ??
      null;
    const amount = amountText ? parseAmount(amountText) : parseAmountFromRow($, row);

    // Reason: "Syy" / "Orsak" / "Reason"
    const reason =
      strongTexts["syy"] ??
      strongTexts["orsak"] ??
      strongTexts["reason"] ??
      null;

    // Date: "Päivämäärä" / "Datum" / "Date"
    const createDate =
      strongTexts["päivämäärä"] ??
      strongTexts["datum"] ??
      strongTexts["date"] ??
      null;

    if (title || amount > 0) {
      fines.push({
        id,
        title,
        amount,
        currency: "EUR",
        reason,
        createDate,
        fetchedAt: now,
      });
    }
  });

  // Try to extract total from a summary row or sum individual amounts
  const total = extractTotal($) ?? fines.reduce((sum, f) => sum + f.amount, 0);

  return { fines, total };
}

/**
 * Parse an amount string like "2,50 €" or "€2.50" into a number.
 */
function parseAmount(text: string): number {
  const cleaned = text.replace(/[€\s]/g, "").replace(",", ".");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Try to find an amount with € symbol anywhere in the row text.
 */
function parseAmountFromRow(
  $: cheerio.CheerioAPI,
  row: ReturnType<cheerio.CheerioAPI>,
): number {
  const rowText = row.text();
  const match = /(\d+[.,]\d{2})\s*€|€\s*(\d+[.,]\d{2})/.exec(rowText);
  if (match) {
    const numStr = (match[1] ?? match[2]).replace(",", ".");
    const num = parseFloat(numStr);
    return isNaN(num) ? 0 : num;
  }
  return 0;
}

/**
 * Try to extract a total amount from a summary/footer row.
 */
function extractTotal($: cheerio.CheerioAPI): number | null {
  const totalSelectors = [
    ".fines-total",
    ".total-amount",
    "tfoot td",
    "tr.total",
    ".myresearch-footer",
  ];

  for (const selector of totalSelectors) {
    const el = $(selector);
    if (el.length > 0) {
      const text = el.text();
      const match = /(\d+[.,]\d{2})\s*€|€\s*(\d+[.,]\d{2})/.exec(text);
      if (match) {
        const numStr = (match[1] ?? match[2]).replace(",", ".");
        const num = parseFloat(numStr);
        if (!isNaN(num)) return num;
      }
    }
  }

  return null;
}
