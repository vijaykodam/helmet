import { CookieJar, type Cookie } from "tough-cookie";
import { fetch, type RequestInit, type Response } from "undici";

export interface SessionState {
  version: 1;
  cookies: CookieJar.Serialized;
  cardNumber: string;
  pin: string;
  savedAt: string;
}

export class AuthenticationError extends Error {}
export class APIError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

export class HelmetSession {
  private baseUrl: string;
  private cookieJar: CookieJar;
  private loggedIn = false;
  private cardNumber?: string;
  private pin?: string;
  private debug = false;

  constructor(baseUrl: string, opts?: { debug?: boolean }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.cookieJar = new CookieJar();
    this.debug = Boolean(opts?.debug);
  }

  /**
   * Serialize the authenticated session so it can be restored later.
   * Includes credentials so the auto-re-auth branch in request() keeps
   * working if the cookies turn out to be stale.
   */
  exportState(): SessionState {
    if (!this.loggedIn || !this.cardNumber || !this.pin) {
      throw new Error("HelmetSession not logged in — cannot export state");
    }
    return {
      version: 1,
      cookies: this.cookieJar.toJSON(),
      cardNumber: this.cardNumber,
      pin: this.pin,
      savedAt: new Date().toISOString(),
    };
  }

  /**
   * Restore a previously authenticated session without hitting the network.
   * The next real request() call will transparently re-auth if cookies are dead.
   */
  static fromState(
    baseUrl: string,
    state: SessionState,
    opts?: { debug?: boolean },
  ): HelmetSession {
    const s = new HelmetSession(baseUrl, opts);
    s.cookieJar = CookieJar.deserializeSync(state.cookies);
    s.loggedIn = true;
    s.cardNumber = state.cardNumber;
    s.pin = state.pin;
    return s;
  }

  async login(cardNumber: string, pin: string): Promise<void> {
    if (this.loggedIn) {
      return;
    }

    // Step 1: GET the login page to establish session cookie and find CSRF token
    const loginPageResp = await this.rawRequest("/MyResearch/UserLogin", { method: "GET" });
    const loginHtml = await loginPageResp.text();

    // Extract CSRF token — Finna renders: name="csrf" value="<token>"
    const csrfMatch = /name="csrf"\s+value="([^"]+)"/.exec(loginHtml)
      ?? /value="([^"]+)"\s+name="csrf"/.exec(loginHtml);

    // Extract target and auth_method from hidden fields
    const targetMatch = /name="target"\s+value="([^"]+)"/.exec(loginHtml)
      ?? /value="([^"]+)"\s+name="target"/.exec(loginHtml);
    const authMethodMatch = /name="auth_method"\s+value="([^"]+)"/.exec(loginHtml)
      ?? /value="([^"]+)"\s+name="auth_method"/.exec(loginHtml);

    // Extract form action URL (defaults to /MyResearch/Home)
    const actionMatch = /id="loginForm"[^>]*action="([^"]+)"/.exec(loginHtml)
      ?? /name="loginForm"[^>]*action="([^"]+)"/.exec(loginHtml);
    const formAction = actionMatch?.[1] ?? "/MyResearch/Home";

    // Step 2: POST login credentials
    const formData = new URLSearchParams();
    formData.set("username", cardNumber);
    formData.set("password", pin);
    if (targetMatch) {
      formData.set("target", targetMatch[1]);
    }
    if (authMethodMatch) {
      formData.set("auth_method", authMethodMatch[1]);
    }
    if (csrfMatch) {
      formData.set("csrf", csrfMatch[1]);
    }
    formData.set("processLogin", "Kirjaudu");

    if (this.debug) {
      console.log(`[helmet] POST ${formAction} with target=${targetMatch?.[1]}, auth_method=${authMethodMatch?.[1]}, csrf=${csrfMatch?.[1]?.slice(0, 8)}...`);
    }

    const resp = await this.rawRequest(formAction, {
      method: "POST",
      body: formData.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      redirect: "manual",
    });

    if (this.debug) {
      console.log(`[helmet] Login POST status: ${resp.status}`);
      console.log(`[helmet] Location: ${resp.headers.get("location")}`);
    }

    // Finna redirects (302) on both success and failure.
    // On success: redirect to / or /MyResearch/Home
    // On failure: redirect back to /MyResearch/UserLogin
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location") ?? "";
      const redirectUrl = location.startsWith("http")
        ? new URL(location).pathname + new URL(location).search
        : location;

      if (this.debug) {
        console.log(`[helmet] Following redirect to: ${redirectUrl}`);
      }

      // Redirect back to login page = authentication failure
      if (redirectUrl.includes("UserLogin")) {
        // Follow redirect to get error message from flash
        const errorResp = await this.rawRequest(redirectUrl, { method: "GET" });
        const errorHtml = await errorResp.text();
        const errorMatch = /class="[^"]*alert-danger[^"]*"[^>]*>([\s\S]*?)<\/div/i.exec(errorHtml);
        const errorMsg = errorMatch?.[1]?.replace(/<[^>]+>/g, "").trim();
        throw new AuthenticationError(
          `Helmet login failed: ${errorMsg || "invalid credentials"}`,
        );
      }

      // Any other redirect (/, /MyResearch/Home, etc.) = success
      // Verify by trying to access an authenticated page
      const verifyResp = await this.rawRequest("/MyResearch/CheckedOut", {
        method: "GET",
        redirect: "manual",
      });

      if (this.debug) {
        console.log(`[helmet] Verify auth: GET /MyResearch/CheckedOut => ${verifyResp.status}`);
        if (verifyResp.status >= 300) {
          console.log(`[helmet] Verify redirect: ${verifyResp.headers.get("location")}`);
        }
      }

      // If verify redirects back to login, auth actually failed
      const verifyLocation = verifyResp.headers.get("location") ?? "";
      if (verifyResp.status >= 300 && verifyLocation.includes("UserLogin")) {
        throw new AuthenticationError("Helmet login failed: session not authenticated");
      }

      this.loggedIn = true;
      this.cardNumber = cardNumber;
      this.pin = pin;
      return;
    }

    // Non-redirect response (200) — check if it shows the login form as primary content
    // Note: Finna embeds a login form in the navbar of every page, so we only check
    // if the *main content* is the login form (id="loginForm" with action to Home)
    const text = await resp.text();
    const mainLoginForm = /id="loginForm"[^>]*action="[^"]*MyResearch\/Home/.test(text);
    if (mainLoginForm && !text.includes("myresearch-menu")) {
      const errorMatch = /class="[^"]*alert-danger[^"]*"[^>]*>([\s\S]*?)<\/div/i.exec(text);
      const errorMsg = errorMatch?.[1]?.replace(/<[^>]+>/g, "").trim();
      throw new AuthenticationError(
        `Helmet login failed: ${errorMsg || "invalid credentials"}`,
      );
    }

    // If the response doesn't look like a dedicated login page, assume success
    this.loggedIn = true;
    this.cardNumber = cardNumber;
    this.pin = pin;
  }

  async request(path: string, init?: RequestInit): Promise<Response> {
    if (!this.loggedIn) {
      throw new AuthenticationError("HelmetSession not logged in – call login() first");
    }

    let resp = await this.rawRequest(path, init);

    // Auto re-authenticate on session expiry (redirect to login page)
    const location = resp.headers.get("location") ?? "";
    if (
      (resp.status === 302 || resp.status === 301) &&
      location.includes("UserLogin") &&
      this.cardNumber &&
      this.pin
    ) {
      if (this.debug) {
        console.log(`[helmet] Session expired, re-authenticating...`);
      }
      this.loggedIn = false;
      await this.login(this.cardNumber, this.pin);
      resp = await this.rawRequest(path, init);
    }

    if (this.debug) {
      console.log(`[helmet] ${init?.method ?? "GET"} ${path} => ${resp.status}`);
    }

    if (resp.status >= 400) {
      throw new APIError(`Helmet HTTP ${resp.status} at ${path}`, resp.status);
    }

    return resp;
  }

  async get(path: string, init?: RequestInit): Promise<Response> {
    return this.request(path, { ...init, method: "GET" });
  }

  async post(path: string, init?: RequestInit): Promise<Response> {
    return this.request(path, { ...init, method: "POST" });
  }

  /**
   * Re-authenticate using stored credentials. Returns true on success, false if
   * no credentials are available (e.g. session was restored without a PIN).
   * Call this when a page returns 200 but with unauthenticated content.
   */
  async tryReauth(): Promise<boolean> {
    if (!this.cardNumber || !this.pin) return false;
    if (this.debug) {
      console.log("[helmet] Session expired (soft-expiry detected), re-authenticating...");
    }
    this.loggedIn = false;
    await this.login(this.cardNumber, this.pin);
    return true;
  }

  private async rawRequest(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(path, this.baseUrl).toString();
    const cookieHeader = this.cookieJar.getCookieStringSync(url);

    const headers = new Headers();
    if (init?.headers) {
      const incoming = init.headers;
      if (incoming instanceof Headers) {
        incoming.forEach((value, key) => headers.set(key, value));
      } else if (Array.isArray(incoming)) {
        for (const entry of incoming) {
          if (entry.length >= 2) {
            headers.set(entry[0], entry[1]);
          }
        }
      } else {
        for (const [key, value] of Object.entries(incoming)) {
          if (value !== undefined) {
            headers.set(key, String(value));
          }
        }
      }
    }

    headers.set("User-Agent", USER_AGENT);
    headers.set("Referer", `${this.baseUrl}/`);
    if (cookieHeader) {
      headers.set("Cookie", cookieHeader);
    }

    if (this.debug) {
      const method = init?.method ?? "GET";
      console.log(`[helmet] ${method} ${url}`);
    }

    const resp = await fetch(url, {
      ...init,
      headers,
    });

    const headersAny = resp.headers as unknown as { getSetCookie?: () => string[] };
    const setCookies = headersAny.getSetCookie?.() ?? [];
    if (setCookies.length) {
      for (const cookie of setCookies) {
        this.cookieJar.setCookieSync(cookie, url);
      }
    } else {
      const single = resp.headers.get("set-cookie");
      if (single) {
        this.cookieJar.setCookieSync(single, url);
      }
    }

    return resp;
  }
}
