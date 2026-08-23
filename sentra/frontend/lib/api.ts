import type { Overview, Snapshot } from "./types";

/** Build-time default. Overridable at runtime — see resolveApiUrl(). */
export const DEFAULT_API_URL = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"
).replace(/\/$/, "");

const STORAGE_KEY = "sentra-api-url";

export function normaliseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";

  // Only supply a scheme when the input has none. Blindly prepending http://
  // turns "ftp://host" into "http://ftp://host", which parses as a valid http
  // URL with host "ftp" — so an unsupported scheme would slip through.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;

  // An opaque scheme such as "javascript:alert(1)" is also left alone so
  // validation can reject it. The negative lookahead keeps "localhost:4000"
  // and "example.com:4000" out of this branch — there the colon introduces a
  // port, not a scheme.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed)) return trimmed;

  // Accept "localhost:4000" as shorthand for http://localhost:4000.
  return `http://${trimmed}`;
}

/** Hostname, or a bracketed IPv6 literal. */
const HOSTNAME =
  /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i;

export function isValidUrl(raw: string): boolean {
  const candidate = normaliseUrl(raw);
  if (!candidate) return false;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  // URL parsing is permissive enough to accept "!!!garbage!!!" as a hostname,
  // which would then be stored as the engine address and fail every request
  // with no explanation.
  return HOSTNAME.test(url.hostname);
}

/**
 * The dashboard is a static bundle, so NEXT_PUBLIC_API_URL is frozen at build
 * time. That would tie one deployment to one engine — instead the URL can be
 * overridden per browser, which lets the hosted build talk to a locally run
 * engine (browsers treat http://localhost as a secure origin, so an HTTPS page
 * may call it).
 */
export function resolveApiUrl(): string {
  if (typeof window === "undefined") return DEFAULT_API_URL;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && isValidUrl(stored)) return normaliseUrl(stored);
  } catch {
    // Blocked storage — fall through to the build-time default.
  }
  return DEFAULT_API_URL;
}

export function setApiUrl(raw: string | null) {
  try {
    if (raw === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, normaliseUrl(raw));
  } catch {
    // Non-fatal: the override just will not persist across reloads.
  }
}

export function hasApiOverride(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return Boolean(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return false;
  }
}

const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";

/**
 * A request that never settles is worse than one that fails: the dashboard
 * sits on a loading skeleton with nothing to retry. Browsers do not time out
 * fetch by default, and a blocked private-network preflight hangs rather than
 * rejecting, so every call carries its own deadline.
 */
const REQUEST_TIMEOUT_MS = 12_000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind: "network" | "http" = "http"
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = resolveApiUrl();
  let res: Response;

  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { "x-api-key": API_KEY } : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    // A network-level failure has no status and no body — the raw
    // "Failed to fetch" tells the user nothing actionable.
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    throw new ApiError(
      timedOut
        ? `No response from ${base} within ${REQUEST_TIMEOUT_MS / 1000}s.`
        : `Cannot reach a Sentra engine at ${base}.`,
      undefined,
      "network"
    );
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const detail =
      (body as { error?: string; detail?: string })?.error ??
      (body as { detail?: string })?.detail ??
      res.statusText;
    throw new ApiError(detail || `Request failed (${res.status})`, res.status);
  }

  return body as T;
}

export const getOverview = () => request<Overview>("/overview");

export const getSnapshots = (wallet: string) =>
  request<{ snapshots: Snapshot[]; total: number }>(
    `/snapshots?wallet=${encodeURIComponent(wallet)}`
  );

export const addWallet = (address: string, label?: string) =>
  request<{ success: boolean; message: string }>("/wallet/add", {
    method: "POST",
    body: JSON.stringify({ address, label }),
  });

export const removeWallet = (address: string) =>
  request<{ success: boolean; message: string }>(
    // Sent as a query param as well as a body: some proxies drop DELETE bodies.
    `/wallet/remove?address=${encodeURIComponent(address)}`,
    { method: "DELETE", body: JSON.stringify({ address }) }
  );

export const sendTestAlert = () =>
  request<{ success: boolean }>("/test/alert", { method: "POST" });
