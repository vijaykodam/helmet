import * as cheerio from "cheerio";

const UNAUTH_TITLE_RE = /<title[^>]*>\s*(kirjaudu|logga in|log in)\b/i;

export function isUnauthenticatedPageHtml(html: string): boolean {
  if (/myresearch-menu/i.test(html)) return false;
  if (UNAUTH_TITLE_RE.test(html)) return true;
  if (/id="loginForm"/i.test(html)) return true;
  if (/name="processLogin"/i.test(html)) return true;
  return false;
}

/**
 * Return the action URL of Finna's login form, or null if the page has none.
 * Uses a DOM query because Finna renders `action` before `id`, and attribute
 * order is not stable across VuFind versions.
 */
export function extractLoginFormAction(html: string): string | null {
  const $ = cheerio.load(html);
  return $("form#loginForm").attr("action") ?? $('form[name="loginForm"]').attr("action") ?? null;
}

/**
 * Inspect the HTML that the login POST returned (non-redirect case).
 * Returns null if the login looks successful. Otherwise returns the error
 * text that Finna shows (empty string if Finna shows none).
 */
export function detectLoginFailure(html: string): string | null {
  if (!isUnauthenticatedPageHtml(html)) return null;
  return extractLoginError(html);
}

/** Return the text of Finna's first error alert (empty string if none). */
export function extractLoginError(html: string): string {
  const $ = cheerio.load(html);
  return $(".alert-danger").first().text().replace(/\s+/g, " ").trim();
}
