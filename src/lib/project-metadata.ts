import { ipfsUrl } from '@/lib/format'

/**
 * ProjectUri JSON round-tripping for the metadata editor. A projectUri can
 * carry fields this app never edits — `tags`, `coverImageUri`, custom fields
 * like a `leagueID` — so an edit must start from the CURRENT pinned JSON and
 * overwrite only what the editor owns, never rebuild the object from known
 * fields (that silently destroys everything else).
 *
 * The editor's Advanced section exposes the custom fields directly: the box
 * is prefilled from the live JSON, and an EDITED box replaces that set (so a
 * removed key is removed on-chain). An untouched box changes nothing.
 */

/** The projectUri fields the metadata editor edits (and may clear). */
const EDITED_METADATA_KEYS = [
  'name',
  'projectTagline',
  'description',
  'logoUri',
  'infoUri',
  'twitter',
  'discord',
  'telegram',
  'whatsapp',
  'instagram',
  'payDisclosure',
] as const

export type EditedMetadataKey = (typeof EDITED_METADATA_KEYS)[number]

/**
 * Recognized projectUri fields the editor never edits but always keeps: the
 * create flow writes them, the pin route validates them, and no form control
 * here can change them. They stay out of the custom-properties box so a save
 * can't delete them by omission.
 */
const RETAINED_METADATA_KEYS = [
  'tags',
  'coverImageUri',
  'version',
] as const

/** Every field the form manages — edited plus retained. */
const MANAGED_METADATA_KEYS: readonly string[] = [
  ...EDITED_METADATA_KEYS,
  ...RETAINED_METADATA_KEYS,
]

const MANAGED = new Set<string>(MANAGED_METADATA_KEYS)

/**
 * Spread every existing key, then apply the editor's fields on top: a
 * provided blank clears the field, a provided value overwrites it, and a
 * field the editor omits entirely is left untouched.
 *
 * `customProperties` is the Advanced box's parsed object and REPLACES the
 * custom-property set wholesale — a key the user removed is deleted on-chain.
 * Pass `undefined` (the box was never edited, or never loaded) to leave the
 * existing custom properties exactly as they are. Managed fields always win
 * a collision; the form's inputs are the source of truth for them.
 */
export function mergeProjectMetadata(
  existing: Record<string, unknown> | null | undefined,
  edits: Partial<Record<EditedMetadataKey, string | undefined>>,
  customProperties?: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing ?? {}) }
  if (customProperties) {
    for (const key of Object.keys(merged)) {
      if (!MANAGED.has(key)) delete merged[key]
    }
    for (const [key, value] of Object.entries(customProperties)) {
      if (MANAGED.has(key)) continue
      merged[key] = value
    }
  }
  for (const key of EDITED_METADATA_KEYS) {
    if (!(key in edits)) continue
    const value = edits[key]
    if (value === undefined || value === '') delete merged[key]
    else merged[key] = value
  }
  return merged
}

/** The recognized fields present that a save keeps but the form can't edit. */
export function preservedMetadataKeys(
  existing: Record<string, unknown> | null | undefined,
): string[] {
  if (!existing) return []
  return RETAINED_METADATA_KEYS.filter(key => key in existing).sort()
}

/** Everything in the metadata that no form field owns — the Advanced box. */
export function customMetadataProperties(
  existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const custom: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(existing ?? {})) {
    if (!MANAGED.has(key)) custom[key] = value
  }
  return custom
}

/** The Advanced box's prefill: pretty JSON, or blank when there's nothing. */
export function customPropertiesText(
  existing: Record<string, unknown> | null | undefined,
): string {
  const custom = customMetadataProperties(existing)
  if (!Object.keys(custom).length) return ''
  return JSON.stringify(custom, null, 2)
}

export type ParsedCustomProperties =
  | { ok: true; properties: Record<string, unknown>; collisions: string[] }
  | { ok: false; error: string }

/**
 * Parse the Advanced box. Invalid JSON is an error the caller must surface —
 * silently dropping what the user typed is the data loss this whole module
 * exists to prevent. Keys the form manages are stripped and reported so the
 * UI can say why they were ignored.
 */
export function parseCustomProperties(text: string): ParsedCustomProperties {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, properties: {}, collisions: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return {
      ok: false,
      error: 'Custom properties must be valid JSON. Check for a stray comma or quote.',
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: 'Custom properties must be a JSON object, like {"leagueID": 42}.',
    }
  }

  const properties: Record<string, unknown> = {}
  const collisions: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (MANAGED.has(key)) collisions.push(key)
    else properties[key] = value
  }
  return { ok: true, properties, collisions: collisions.sort() }
}

/**
 * Fetch the current pinned projectUri JSON. Throws when the fetch fails so
 * a save can fail CLOSED — merging over `{}` because a gateway hiccuped is
 * exactly the data loss the merge exists to prevent.
 */
export async function fetchProjectMetadataJson(
  metadataUri: string,
): Promise<Record<string, unknown>> {
  const url = ipfsUrl(metadataUri)
  if (!url) {
    throw new Error('The current project metadata URI is not readable.')
  }
  let json: unknown
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`status ${response.status}`)
    json = await response.json()
  } catch {
    throw new Error(
      'Could not load the current project metadata, so saving would drop its existing fields. Try again.',
    )
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('The current project metadata is not a JSON object.')
  }
  return json as Record<string, unknown>
}
