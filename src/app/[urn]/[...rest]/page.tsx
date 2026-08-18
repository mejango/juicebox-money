import { redirect } from "next/navigation";
import { LEGACY_SITE } from "@/lib/urn";

/**
 * No V6 route runs more than one path segment deep, so any deeper path is a
 * legacy V1–V5 URL (e.g. /v3/45, /v5/base/345). Hand it — query string
 * included — to the app now serving from old.juicebox.money.
 */
export default async function LegacyPath({
  params,
  searchParams,
}: {
  params: Promise<{ urn: string; rest: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { urn, rest } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
    for (const item of items) query.append(key, item);
  }
  const search = query.toString();
  redirect(
    `${LEGACY_SITE}/${[urn, ...rest].join("/")}${search ? `?${search}` : ""}`,
  );
}
