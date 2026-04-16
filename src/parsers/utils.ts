import type * as cheerio from "cheerio";

/**
 * Extract all <strong>Label: Value</strong> pairs from a container.
 * Finna puts label and value in the same <strong> element:
 *   <strong>Eräpäivä: 11.5.2026</strong>
 *   <strong>Uusittu: 1</strong>
 * Returns a map of lowercase label → value.
 */
export function extractStrongValues(
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
 * Extract <strong>Label:</strong> Value pairs where the value is a sibling text node.
 * This is used on the holds page where Finna renders:
 *   <strong>Noutopaikka:</strong> Sample Branch
 *   <strong>Luotu:</strong> 1.1.2026
 *
 * Also picks up inline values (same-element) as a fallback.
 * Returns a map of lowercase label → value.
 */
export function extractStrongSiblingValues(
  $: cheerio.CheerioAPI,
  container: ReturnType<cheerio.CheerioAPI>,
): Record<string, string> {
  const values: Record<string, string> = {};

  container.find("strong").each((_i, el) => {
    const strongText = $(el).text().trim();
    const colonIdx = strongText.indexOf(":");
    if (colonIdx <= 0) return;

    const label = strongText.slice(0, colonIdx).trim().toLowerCase();
    const inlineValue = strongText.slice(colonIdx + 1).trim();

    if (inlineValue) {
      values[label] = inlineValue;
    } else {
      // Sibling: <strong>Label:</strong> Value
      // Walk sibling text nodes after the <strong>
      const parent = $(el).parent();
      const parentHtml = parent.html() ?? "";
      const strongHtml = $.html(el);
      const afterStrong = parentHtml.split(strongHtml)[1] ?? "";
      // Take text up to the next HTML tag
      const textMatch = /^\s*([^<]+)/.exec(afterStrong);
      const siblingValue = textMatch?.[1]?.trim() ?? "";
      if (label && siblingValue) {
        values[label] = siblingValue;
      }
    }
  });

  return values;
}
