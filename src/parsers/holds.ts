import * as cheerio from "cheerio";
import type { Hold } from "../types.js";
import { extractStrongSiblingValues } from "./utils.js";

/**
 * Parse the /MyResearch/Holds page HTML into structured Hold objects.
 *
 * Finna renders holds as <tr class="myresearch-row"> rows. Each row contains:
 *   - Checkbox column with cancelAllIDS[] / selectedIDS[] inputs
 *   - Cover image
 *   - .holds-status-information div with metadata
 *
 * Unlike loans (which use <strong>Label: Value</strong> in one element),
 * holds use <strong>Label:</strong> Value as sibling text nodes.
 *
 * Finnish labels: Noutopaikka (pickup location), Sijainti jonossa (queue position),
 * Luotu (created date), Viimeinen noutopäivä (last pickup date).
 */
export function parseHolds(html: string): Hold[] {
  const $ = cheerio.load(html);
  const holds: Hold[] = [];
  const now = new Date();

  $("tr.myresearch-row").each((_i, el) => {
    const row = $(el);

    if (row.hasClass("visually-hidden")) return;

    // Item ID from cancelAllIDS[] or selectedIDS[] checkbox
    const id =
      row.find("input[name='cancelAllIDS[]']").attr("value") ??
      row.find("input[name='selectedIDS[]']").attr("value") ??
      row.attr("id")?.replace("record", "") ??
      "";

    // Title from h3.record-title > a
    const title = row.find("h3.record-title a").first().text().trim()
      || row.find(".record-title").first().text().trim()
      || "Unknown";

    // Author from span.authority-label
    const author = row.find("span.authority-label").first().text().trim() || null;

    // Parse <strong>Label:</strong> Value pairs from the holds status area
    const statusInfo = row.find(".holds-status-information");
    const strongTexts = extractStrongSiblingValues($, statusInfo);

    // Pickup location: "Noutopaikka" / "Avhämtningsbibliotek" / "Pickup library"
    const pickupLocation =
      strongTexts["noutopaikka"] ??
      strongTexts["avhämtningsbibliotek"] ??
      strongTexts["pickup library"] ??
      null;

    // Queue position: "Sijainti jonossa" / "Köplats" / "Queue position"
    // Finna formats this as "1 / 3" — take the first number (your position)
    const queueText =
      strongTexts["sijainti jonossa"] ??
      strongTexts["köplats"] ??
      strongTexts["queue position"] ??
      null;
    const queuePosition = queueText ? parseInt(queueText, 10) : null;

    // Expiration date: "Viimeinen noutopäivä" / "Sista avhämtningsdag" / "Last pickup date"
    // or created date: "Luotu" / "Skapad" / "Created"
    const expirationDate =
      strongTexts["viimeinen noutopäivä"] ??
      strongTexts["sista avhämtningsdag"] ??
      strongTexts["last pickup date"] ??
      strongTexts["luotu"] ??
      strongTexts["skapad"] ??
      strongTexts["created"] ??
      null;

    // Status from alert classes and text content
    const status = deriveHoldStatus($, row);

    // Cancelable if there is a selectable checkbox
    const cancelable = row.find("input[name='selectedIDS[]']").length > 0;

    if (id || title !== "Unknown") {
      holds.push({
        id,
        title,
        author,
        pickupLocation,
        queuePosition: isNaN(queuePosition ?? NaN) ? null : queuePosition,
        expirationDate,
        status,
        cancelable,
        fetchedAt: now,
      });
    }
  });

  return holds;
}

function deriveHoldStatus(
  $: cheerio.CheerioAPI,
  row: ReturnType<cheerio.CheerioAPI>,
): Hold["status"] {
  const rowText = row.text().toLowerCase();

  // Available for pickup
  if (
    row.find(".alert-success").length > 0 ||
    rowText.includes("noudettavissa") ||
    rowText.includes("available for pickup") ||
    rowText.includes("kan avhämtas")
  ) {
    return "available_for_pickup";
  }

  // In transit
  if (
    rowText.includes("kuljetuksessa") ||
    rowText.includes("in transit") ||
    rowText.includes("under transport")
  ) {
    return "in_transit";
  }

  return "pending";
}
