const UNAUTH_TITLE_RE = /<title[^>]*>\s*(kirjaudu|logga in|log in)\b/i;

export function isUnauthenticatedPageHtml(html: string): boolean {
  if (/myresearch-menu/i.test(html)) return false;
  if (UNAUTH_TITLE_RE.test(html)) return true;
  if (/id="loginForm"/i.test(html)) return true;
  if (/name="processLogin"/i.test(html)) return true;
  return false;
}
