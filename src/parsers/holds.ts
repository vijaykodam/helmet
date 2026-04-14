import * as cheerio from "cheerio";
import type { Hold, HoldActionResult } from "../types.js";
import { extractStrongSiblingValues } from "./utils.js";

export interface PickupLocationOption {
  value: string;
  label: string;
  selected: boolean;
}

export interface HoldPlaceForm {
  csrf: string | null;
  pickupLocations: PickupLocationOption[];
}

export interface HoldLink {
  recordId: string;
  level: string | null;
  hashKey: string | null;
  href: string;
}

export class HoldFormUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldFormUnavailableError";
  }
}

const HOLD_SESSION_EXPIRED_MESSAGE =
  "Session expired — Finna served a login page instead of hold details.";

export { isUnauthenticatedPageHtml as isUnauthenticatedHoldHtml } from "./auth-detect.js";
import { isUnauthenticatedPageHtml } from "./auth-detect.js";

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

export function extractHoldLinks(html: string): HoldLink[] {
  const $ = cheerio.load(html);
  const links: HoldLink[] = [];

  $("a.placehold[href*='/Hold']").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const pathOnly = href.split("#")[0]!;
    const [path, query = ""] = pathOnly.split("?");
    const params = new URLSearchParams(query);

    const match = /\/Record\/([^/]+)\/Hold/.exec(path!);
    if (!match) return;

    links.push({
      recordId: decodeURIComponent(match[1]!),
      level: params.get("level"),
      hashKey: params.get("hashKey"),
      href,
    });
  });

  return links;
}

export function extractHoldPlaceForm(html: string): HoldPlaceForm {
  const $ = cheerio.load(html);

  if (isUnauthenticatedPageHtml(html)) {
    throw new HoldFormUnavailableError(HOLD_SESSION_EXPIRED_MESSAGE);
  }

  const select =
    $("select[name='gatheredDetails[pickUpLocation]']").first().length > 0
      ? $("select[name='gatheredDetails[pickUpLocation]']").first()
      : $("select[name='pickUpLocation']").first();

  const pickupLocations: PickupLocationOption[] = [];
  select.find("option").each((_i, el) => {
    const opt = $(el);
    const value = opt.attr("value") ?? "";
    const label = opt.text().trim();
    const selected = opt.attr("selected") !== undefined;
    if (value) {
      pickupLocations.push({ value, label, selected });
    }
  });

  if (pickupLocations.length === 0) {
    const alertText = $(".alert-danger, .alert-warning")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    if (alertText) {
      throw new HoldFormUnavailableError(alertText);
    }

    const hasHoldForm =
      $("form[name='placeHold']").length > 0 || $("[name='placeHold']").length > 0;
    if (!hasHoldForm) {
      throw new HoldFormUnavailableError(
        "Hold form unavailable — Finna served unexpected content.",
      );
    }
  }

  return { csrf: null, pickupLocations };
}

/**
 * Consolidate Finna flash alerts on a response HTML into a single action result.
 */
const HOLD_SUCCESS_MARKERS = [
  "varauspyyntö onnistui",
  "varaus tehty",
  "your request was successful",
  "hold placed",
  "din reservation",
];

export function parseHoldActionResult(html: string): HoldActionResult {
  if (isUnauthenticatedPageHtml(html)) {
    return { success: false, message: HOLD_SESSION_EXPIRED_MESSAGE };
  }

  const $ = cheerio.load(html);

  const success = $(".alert-success").first().text().replace(/\s+/g, " ").trim();
  if (success) {
    return { success: true, message: success };
  }

  const danger = $(".alert-danger").first().text().replace(/\s+/g, " ").trim();
  if (danger) {
    return { success: false, message: danger };
  }

  const bodyText = $("body").text().toLowerCase();
  for (const marker of HOLD_SUCCESS_MARKERS) {
    if (bodyText.includes(marker)) {
      return { success: true, message: marker };
    }
  }

  return { success: true, message: null };
}
