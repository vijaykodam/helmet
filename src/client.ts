import { HelmetSession, AuthenticationError, type SessionState } from "./session.js";
import type {
  HelmetProfile,
  Loan,
  Hold,
  Fine,
  RenewalResult,
  SearchResponse,
  SearchResult,
  AccountSummary,
  HoldActionResult,
} from "./types.js";
import { parseLoans, parseRenewalResults, extractRenewalCsrf } from "./parsers/loans.js";
import {
  parseHolds,
  extractHoldLinks,
  extractHoldPlaceForm,
  HoldFormUnavailableError,
  isUnauthenticatedHoldHtml,
  parseHoldActionResult,
} from "./parsers/holds.js";
import { isUnauthenticatedPageHtml } from "./parsers/auth-detect.js";
import { parseFines } from "./parsers/fines.js";
import type { RequestInit } from "undici";

const FINNA_API = "https://api.finna.fi";

export class HelmetClient {
  private session: HelmetSession;

  private constructor(session: HelmetSession) {
    this.session = session;
  }

  static async login(profile: HelmetProfile): Promise<HelmetClient> {
    const session = new HelmetSession(profile.baseUrl, {
      debug: profile.debug ?? false,
    });
    await session.login(profile.cardNumber, profile.pin);
    return new HelmetClient(session);
  }

  /**
   * Restore a client from a previously exported session. No network I/O;
   * the first authenticated request will re-auth transparently if cookies
   * have expired (see HelmetSession.request).
   */
  static resume(profile: HelmetProfile, state: SessionState): HelmetClient {
    const session = HelmetSession.fromState(profile.baseUrl, state, {
      debug: profile.debug ?? false,
    });
    return new HelmetClient(session);
  }

  exportState(): SessionState {
    return this.session.exportState();
  }

  /**
   * Fetch an authenticated Finna page and guard against the soft-expiry case
   * where Finna returns HTTP 200 with a login page instead of the requested
   * data. On detection, attempt one transparent re-auth using stored credentials.
   * If that also returns a login page (or no credentials are stored), throw
   * AuthenticationError so callers can surface a clean error instead of
   * parsing an empty page as "no data".
   */
  private async authedFetch(
    path: string,
    init?: RequestInit,
  ): Promise<string> {
    const method = (init?.method ?? "GET").toUpperCase();
    const doFetch = async () => {
      const resp = method === "POST"
        ? await this.session.post(path, init)
        : await this.session.get(path, init);
      return resp.text();
    };

    let html = await doFetch();
    if (!isUnauthenticatedPageHtml(html)) return html;

    if (await this.session.tryReauth()) {
      html = await doFetch();
      if (!isUnauthenticatedPageHtml(html)) return html;
    }

    throw new AuthenticationError(
      "Helmet session expired and re-authentication failed — run `helmet login` to refresh credentials.",
    );
  }

  loans = {
    list: async (): Promise<Loan[]> => {
      const html = await this.authedFetch("/MyResearch/CheckedOut");
      return parseLoans(html);
    },

    renew: async (itemId: string): Promise<RenewalResult[]> => {
      const pageHtml = await this.authedFetch("/MyResearch/CheckedOut");
      const csrf = extractRenewalCsrf(pageHtml);

      const formData = new URLSearchParams();
      if (csrf) {
        formData.set("csrf", csrf);
      }
      formData.append("renewSelectedIDS[]", itemId);
      formData.set("renewSelected", "1");

      const html = await this.authedFetch("/MyResearch/CheckedOut", {
        method: "POST",
        body: formData.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      return parseRenewalResults(html, [itemId]);
    },

    renewAll: async (): Promise<RenewalResult[]> => {
      const pageHtml = await this.authedFetch("/MyResearch/CheckedOut");
      const csrf = extractRenewalCsrf(pageHtml);
      const loans = parseLoans(pageHtml);
      const renewableIds = loans.filter((l) => l.renewable).map((l) => l.id);

      const formData = new URLSearchParams();
      if (csrf) {
        formData.set("csrf", csrf);
      }
      for (const id of renewableIds) {
        formData.append("renewAllIDS[]", id);
      }
      formData.set("renewAll", "1");

      const html = await this.authedFetch("/MyResearch/CheckedOut", {
        method: "POST",
        body: formData.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      return parseRenewalResults(html, renewableIds);
    },
  };

  holds = {
    list: async (): Promise<Hold[]> => {
      const html = await this.authedFetch("/MyResearch/Holds");
      return parseHolds(html);
    },

    place: async (
      recordId: string,
      opts?: { pickupLocation?: string; comment?: string },
    ): Promise<HoldActionResult> => {
      const recordPath = `/Record/${encodeURIComponent(recordId)}`;
      const ajaxPath = `${recordPath}/AjaxTab`;
      const sessionExpiredMessage =
        "Session expired while loading hold details — please retry after logging in again.";

      const fetchHoldingsTab = async (): Promise<string> => {
        const resp = await this.session.post(ajaxPath, {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "tab=holdings&sid=",
        });
        return resp.text();
      };

      const runPlaceFlow = async (allowRetry: boolean): Promise<HoldActionResult> => {
        // 1) Fetch the holdings tab via AJAX to harvest the session-scoped hashKey.
        // Finna lazy-loads the place-hold link into the holdings tab content; the
        // initial server-rendered record page does not include it. The hashKey'd
        // URL is required — without it, /Record/{id}/Hold silently serves the
        // record page instead of the hold form.
        const holdingsHtml = await fetchHoldingsTab();
        if (isUnauthenticatedHoldHtml(holdingsHtml)) {
          if (allowRetry && (await this.session.tryReauth())) {
            return runPlaceFlow(false);
          }
          return {
            success: false,
            message: sessionExpiredMessage,
          };
        }

        const links = extractHoldLinks(holdingsHtml);
        const link = links.find((l) => l.recordId === recordId) ?? links[0];
        if (!link) {
          return {
            success: false,
            message:
              "No hold link found in the holdings tab — title may not be holdable for this account.",
          };
        }

        // 2) GET the hashKey'd URL with layout=lightbox → real form fragment.
        const holdUrl = appendLightboxParam(link.href);
        const formHtml = await (await this.session.get(holdUrl)).text();
        if (isUnauthenticatedHoldHtml(formHtml)) {
          if (allowRetry && (await this.session.tryReauth())) {
            return runPlaceFlow(false);
          }
          return {
            success: false,
            message: sessionExpiredMessage,
          };
        }

        let form: ReturnType<typeof extractHoldPlaceForm>;
        try {
          form = extractHoldPlaceForm(formHtml);
        } catch (err) {
          if (err instanceof HoldFormUnavailableError) {
            return {
              success: false,
              message: err.message,
            };
          }
          throw err;
        }

        const pickup =
          opts?.pickupLocation ??
          form.pickupLocations.find((o) => o.selected)?.value ??
          form.pickupLocations[0]?.value;
        if (!pickup) {
          return {
            success: false,
            message: "No pickup locations offered for this record.",
          };
        }

        // 3) POST to the same URL. No CSRF — cookie + hashKey are sufficient.
        const body = new URLSearchParams();
        body.set("gatheredDetails[pickUpLocation]", pickup);
        body.set("gatheredDetails[comment]", opts?.comment ?? "");
        body.set("layout", "lightbox");
        body.set("placeHold", "Lähetä");

        const postHtml = await (
          await this.session.post(holdUrl, {
            body: body.toString(),
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          })
        ).text();

        if (isUnauthenticatedHoldHtml(postHtml)) {
          if (allowRetry && (await this.session.tryReauth())) {
            return runPlaceFlow(false);
          }
          return {
            success: false,
            message: sessionExpiredMessage,
          };
        }

        return parseHoldActionResult(postHtml);
      };

      return runPlaceFlow(true);
    },

    cancel: async (holdId: string): Promise<HoldActionResult> => {
      // Finna's cancel form lives at /Holds/List (not /MyResearch/Holds) and
      // uses a two-step confirmation. Sending confirm=1 on the first POST
      // skips the confirmation screen. No CSRF input — session cookie suffices.
      const body = new URLSearchParams();
      body.append("selectedIDS[]", holdId);
      body.append("cancelSelectedIDS[]", holdId);
      body.set("cancelSelected", "1");
      body.set("confirm", "1");

      const resp = await this.session.post("/Holds/List", {
        body: body.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      return parseHoldActionResult(await resp.text());
    },
  };

  fines = {
    list: async (): Promise<{ fines: Fine[]; total: number }> => {
      const html = await this.authedFetch("/MyResearch/Fines");
      return parseFines(html);
    },
  };

  status = {
    check: async (): Promise<{ authenticated: true } | { authenticated: false; message: string }> => {
      try {
        await this.authedFetch("/MyResearch/CheckedOut");
        return { authenticated: true };
      } catch (err) {
        if (err instanceof AuthenticationError) {
          return { authenticated: false, message: err.message };
        }
        throw err;
      }
    },
  };

  search = {
    query: async (
      lookfor: string,
      opts?: { limit?: number; page?: number },
    ): Promise<SearchResponse> => {
      const params = new URLSearchParams({
        lookfor,
        "filter[]": "building:0/Helmet/",
        limit: String(opts?.limit ?? 20),
        page: String(opts?.page ?? 1),
      });

      const resp = await globalThis.fetch(
        `${FINNA_API}/v1/search?${params.toString()}`,
      );
      const data = (await resp.json()) as Record<string, unknown>;

      const records = ((data.records ?? []) as Record<string, unknown>[]).map(
        (r): SearchResult => ({
          id: String(r.id ?? ""),
          title: String(r.title ?? ""),
          author: extractAuthor(r),
          year: (r.year as string) ?? null,
          formats: (r.formats ?? []) as string[],
          languages: (r.languages ?? []) as string[],
          buildings: (r.buildings ?? []) as string[],
          subjects: (r.subjects ?? []) as string[],
          isbn: ((r.isbns ?? []) as string[])[0] ?? null,
        }),
      );

      return {
        resultCount: (data.resultCount as number) ?? 0,
        records,
        status: String(data.status ?? "OK"),
      };
    },
  };

  summary = {
    get: async (): Promise<AccountSummary> => {
      const [loans, holdsData, finesData] = await Promise.all([
        this.loans.list(),
        this.holds.list(),
        this.fines.list(),
      ]);

      const now = new Date();
      const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

      const loansDueSoon = loans.filter((l) => {
        if (!l.dueDate) return false;
        const due = parseDateString(l.dueDate);
        return due && due <= threeDaysFromNow && due >= now;
      });

      const loansOverdue = loans.filter((l) => l.dueStatus === "overdue");

      return {
        loans,
        holds: holdsData,
        fines: finesData.fines,
        totalFines: finesData.total,
        loansDueSoon,
        loansOverdue,
        holdsReady: holdsData.filter((h) => h.status === "available_for_pickup"),
        fetchedAt: now,
      };
    },
  };
}

function extractAuthor(record: Record<string, unknown>): string | null {
  if (typeof record.primaryAuthor === "string" && record.primaryAuthor) {
    return record.primaryAuthor;
  }
  const authors = record.authors as Record<string, Record<string, unknown>> | undefined;
  if (authors?.primary) {
    const keys = Object.keys(authors.primary);
    if (keys.length > 0) return keys[0];
  }
  return null;
}

function appendLightboxParam(href: string): string {
  // Preserve path + existing params; add layout=lightbox if absent; strip fragment.
  const [pathWithQuery] = href.split("#");
  const [path, query = ""] = pathWithQuery!.split("?");
  const params = new URLSearchParams(query);
  if (!params.has("layout")) params.set("layout", "lightbox");
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path!;
}

function parseDateString(dateStr: string): Date | null {
  // Try Finnish format dd.mm.yyyy
  const fiMatch = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(dateStr);
  if (fiMatch) {
    return new Date(
      parseInt(fiMatch[3], 10),
      parseInt(fiMatch[2], 10) - 1,
      parseInt(fiMatch[1], 10),
    );
  }
  // Try ISO format
  const date = new Date(dateStr);
  return isNaN(date.getTime()) ? null : date;
}
