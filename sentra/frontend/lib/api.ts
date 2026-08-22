import type { Overview, Snapshot } from "./types";

/** Build-time default. Overridable at runtime — see resolveApiUrl(). */
export const DEFAULT_API_URL = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"
).replace(/\/$/, "");

const STORAGE_KEY = "sentra-api-url";

export function normaliseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  // Accept "localhost:4000" as shorthand.
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function isValidUrl(raw: string): boolean {
  try {
    const url = new URL(normaliseUrl(raw));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { "x-api-key": API_KEY } : {}),
        ...init?.headers,
      },
    });
  } catch {
    // A network-level failure has no status and no body — the raw
    // "Failed to fetch" tells the user nothing actionable.
    throw new ApiError(
      `Cannot reach a Sentra engine at ${base}.`,
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
