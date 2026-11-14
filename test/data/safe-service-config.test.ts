// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

const SAFE = "0x240dc2085caEF779F428dcd103CFD2fB510EdE82";
const HASH = `0x${"11".repeat(32)}` as const;

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

it.each([
  ["https://juicebox.money", "https://juicebox.center", false],
  ["https://dev.juicebox.money", "https://dev.juicebox.center", false],
  ["https://juicebox.money", "https://juicebox.center", true],
  ["https://dev.juicebox.money", "https://dev.juicebox.center", true],
] as const)("routes the first Safe read from %s through Center without a browser key", async (site, center, server) => {
  if (server) vi.stubGlobal("window", undefined);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", site);
  vi.stubGlobal("localStorage", { getItem: (key: string) => key === "jb-safe-api-key" ? "browser-key" : null });
  const sdk = await import("@/lib/safe-service-config");
  const request = vi.fn(async () => new Response("not found", { status: 404 }));
  await expect(sdk.readSafeTransaction(8453, SAFE, HASH, { fetch: request })).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
  const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(`${center}/v1/safe/base/api/v1/multisig-transactions/${HASH}/`);
  expect(new Headers(init.headers).has("authorization")).toBe(false);
  expect(new Headers(init.headers).get("origin")).toBe(server ? site : null);
});
