import { HelmetSession } from "./session.js";
import type {
  HelmetProfile,
  Loan,
  Hold,
  Fine,
  RenewalResult,
  SearchResponse,
  SearchResult,
  AccountSummary,
} from "./types.js";
import { parseLoans, parseRenewalResults, extractRenewalCsrf } from "./parsers/loans.js";
import { parseHolds } from "./parsers/holds.js";
import { parseFines } from "./parsers/fines.js";

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

  loans = {
    list: async (): Promise<Loan[]> => {
      const resp = await this.session.get("/MyResearch/CheckedOut");
      const html = await resp.text();
      return parseLoans(html);
    },

    renew: async (itemId: string): Promise<RenewalResult[]> => {
      // First get the page to extract CSRF token
      const pageResp = await this.session.get("/MyResearch/CheckedOut");
      const pageHtml = await pageResp.text();
      const csrf = extractRenewalCsrf(pageHtml);

      const formData = new URLSearchParams();
      if (csrf) {
        formData.set("csrf", csrf);
      }
      formData.append("renewSelectedIDS[]", itemId);
      formData.set("renewSelected", "1");

      const resp = await this.session.post("/MyResearch/CheckedOut", {
        body: formData.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      const html = await resp.text();
      return parseRenewalResults(html, [itemId]);
    },

    renewAll: async (): Promise<RenewalResult[]> => {
      // Get page for CSRF + all renewable IDs
      const pageResp = await this.session.get("/MyResearch/CheckedOut");
      const pageHtml = await pageResp.text();
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

      const resp = await this.session.post("/MyResearch/CheckedOut", {
        body: formData.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      const html = await resp.text();
      return parseRenewalResults(html, renewableIds);
    },
  };

  holds = {
    list: async (): Promise<Hold[]> => {
      const resp = await this.session.get("/MyResearch/Holds");
      const html = await resp.text();
      return parseHolds(html);
    },
  };

  fines = {
    list: async (): Promise<{ fines: Fine[]; total: number }> => {
      const resp = await this.session.get("/MyResearch/Fines");
      const html = await resp.text();
      return parseFines(html);
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
