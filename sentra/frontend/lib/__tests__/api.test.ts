/**
 * API client tests.
 *
 * The engine URL is resolvable at runtime so one static build can talk to any
 * backend. That indirection is easy to get subtly wrong, and a wrong base URL
 * shows up to the user as "cannot reach the engine" with no clue why.
 */
import { beforeEach, describe, expect, test, vi, afterEach } from "vitest";
import {
  normaliseUrl,
  isValidUrl,
  resolveApiUrl,
  setApiUrl,
  hasApiOverride,
  DEFAULT_API_URL,
  ApiError,
  getOverview,
  addWallet,
  removeWallet,
} from "../api";

// Minimal localStorage stand-in — the module must work in a browser and must
// not throw when storage is unavailable.
function installStorage(impl?: Partial<Storage>) {
  const store = new Map<string, string>();
  const base: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => store.get(k) ?? null,
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => void store.set(k, v),
  };
  vi.stubGlobal("window", { localStorage: { ...base, ...impl } });
  vi.stubGlobal("localStorage", { ...base, ...impl });
}

beforeEach(() => installStorage());
afterEach(() => vi.unstubAllGlobals());

describe("normaliseUrl", () => {
  test("adds a scheme and strips trailing slashes", () => {
    expect(normaliseUrl("localhost:4000")).toBe("http://localhost:4000");
    expect(normaliseUrl("http://localhost:4000/")).toBe("http://localhost:4000");
    expect(normaliseUrl("https://api.example.com///")).toBe(
      "https://api.example.com"
    );
    expect(normaliseUrl("  http://x.dev  ")).toBe("http://x.dev");
    expect(normaliseUrl("")).toBe("");
  });
});

describe("isValidUrl", () => {
  test("accepts http and https, rejects anything else", () => {
    expect(isValidUrl("localhost:4000")).toBe(true);
    expect(isValidUrl("https://engine.onrender.com")).toBe(true);
    expect(isValidUrl("")).toBe(false);
    expect(isValidUrl("not a url")).toBe(false);
    // A javascript: URL in a field the user controls must never pass.
    expect(isValidUrl("javascript:alert(1)")).toBe(false);
    expect(isValidUrl("ftp://files.example.com")).toBe(false);
  });
});

describe("engine URL override", () => {
  test("falls back to the build-time default", () => {
    expect(resolveApiUrl()).toBe(DEFAULT_API_URL);
    expect(hasApiOverride()).toBe(false);
  });

  test("a stored override wins and is normalised", () => {
    setApiUrl("engine.example.com:4000");
    expect(resolveApiUrl()).toBe("http://engine.example.com:4000");
    expect(hasApiOverride()).toBe(true);
  });

  test("clearing restores the default", () => {
    setApiUrl("https://x.dev");
    setApiUrl(null);
    expect(resolveApiUrl()).toBe(DEFAULT_API_URL);
    expect(hasApiOverride()).toBe(false);
  });

  test("a corrupt stored value is ignored, not propagated", () => {
    localStorage.setItem("sentra-api-url", "!!!not-a-url!!!");
    expect(resolveApiUrl()).toBe(DEFAULT_API_URL);
  });

  test("blocked storage degrades instead of throwing", () => {
    installStorage({
      getItem: () => {
        throw new DOMException("denied");
      },
      setItem: () => {
        throw new DOMException("denied");
      },
    });

    expect(() => resolveApiUrl()).not.toThrow();
    expect(resolveApiUrl()).toBe(DEFAULT_API_URL);
    expect(() => setApiUrl("https://x.dev")).not.toThrow();
    expect(hasApiOverride()).toBe(false);
  });
});

describe("request handling", () => {
  test("a network failure becomes an actionable ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("nope")));

    await expect(getOverview()).rejects.toThrow(ApiError);
    await expect(getOverview()).rejects.toThrow(/Cannot reach a Sentra engine/);
  });

  test("a timeout is reported distinctly from an unreachable host", async () => {
    const timeout = new DOMException("timed out", "TimeoutError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));

    await expect(getOverview()).rejects.toThrow(/No response from/);
  });

  test("an error body is surfaced rather than the bare status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ error: "Invalid Solana address: nope" }),
      })
    );

    await expect(addWallet("nope")).rejects.toThrow(
      /Invalid Solana address: nope/
    );
  });

  test("a non-JSON error body still yields a usable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: async () => {
          throw new Error("not json");
        },
      })
    );

    await expect(getOverview()).rejects.toThrow(/Bad Gateway/);
  });

  test("requests carry the resolved base URL and a timeout signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    setApiUrl("https://engine.example.com");
    await getOverview();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://engine.example.com/overview");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeDefined();
  });

  test("removeWallet sends the address by query and by body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await removeWallet("So11111111111111111111111111111111111111112");

    const [url, init] = fetchMock.mock.calls[0];
    // Belt and braces: some proxies drop DELETE bodies entirely.
    expect(url).toContain("?address=So1111");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body).address).toContain("So1111");
  });
});
