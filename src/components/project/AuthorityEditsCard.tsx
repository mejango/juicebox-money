'use client'

import {
  JBCoreContracts,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
} from '@bananapus/nana-sdk-core'
import { getTokenAddress } from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  encodeFunctionData,
  erc20Abi,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { ChainIcon } from '@/components/ChainIcon'
import { ActionRowsSkeleton } from '@/components/LoadingSkeletons'
import { AddressLabel } from '@/components/ui/AddressLabel'
import type { AuthorityDeployment } from '@/components/project/AuthorityOverview'
import { ChainPicker } from '@/components/ui/ChainPicker'
import { ErrorNote } from '@/components/ui/TxError'
import {
  clientFor,
  readAuthorityOf,
  runAuthorityCalls,
  safeOutcomeMessage,
  type AuthorityCall,
} from '@/lib/authority'
import { projectLogoUrl } from '@/lib/format'
import { TOKEN_SYMBOL_RE, omnichainTokenSalt } from '@/lib/manage'
import {
  customPropertiesText,
  fetchProjectMetadataJson,
  mergeProjectMetadata,
  parseCustomProperties,
  preservedMetadataKeys,
} from '@/lib/project-metadata'
import {
  buildDeployTokenAuthorityCall,
  buildTokenMetadataAuthorityCall,
} from '@/lib/transaction-builders'
import { chainName } from '@/lib/urn'

const MAX_LOGO_BYTES = 1024 * 1024

export type AuthorityEditProfile = {
  name: string
  tagline: string
  description: string
  logoUri: string | null
  infoUri?: string
  twitter?: string
  discord?: string
  telegram?: string
  whatsapp?: string
  instagram?: string
  coverImageUri?: string
  payDisclosure?: string
}

type EditChainState = AuthorityDeployment & {
  name: string
  authority: Address | null
  controller: Address | null
  uri: string | null
  token: Address | null
  tokenName: string | null
  tokenSymbol: string | null
  error: string | null
}

async function readEditState(
  deployment: AuthorityDeployment,
  isRevnet: boolean,
): Promise<EditChainState> {
  const client = clientFor(deployment.chainId)
  const authority = await readAuthorityOf(client, deployment, {
    indexedOnly: isRevnet,
  })

  const controller = (await client
    .readContract({
      address: jbContractAddress['6'][JBCoreContracts.JBDirectory][
        deployment.chainId
      ],
      abi: jbDirectoryAbi,
      functionName: 'controllerOf',
      args: [BigInt(deployment.projectId)],
    })
    .catch(() => null)) as Address | null

  const [uri, token] = await Promise.all([
    controller && controller !== zeroAddress
      ? client
          .readContract({
            address: controller,
            abi: jbControllerAbi,
            functionName: 'uriOf',
            args: [BigInt(deployment.projectId)],
          })
          .catch(() => null)
      : null,
    getTokenAddress(client, {
      chainId: deployment.chainId,
      projectId: BigInt(deployment.projectId),
    }).catch(() => null),
  ])

  const [tokenName, tokenSymbol] = token
    ? await Promise.all([
        client
          .readContract({ address: token, abi: erc20Abi, functionName: 'name' })
          .catch(() => null),
        client
          .readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
          .catch(() => null),
      ])
    : [null, null]

  return {
    ...deployment,
    name: chainName(deployment.chainId),
    authority,
    controller: controller && controller !== zeroAddress ? controller : null,
    uri: typeof uri === 'string' && uri ? uri : null,
    token,
    tokenName: typeof tokenName === 'string' ? tokenName : null,
    tokenSymbol: typeof tokenSymbol === 'string' ? tokenSymbol : null,
    error:
      !authority || !controller || controller === zeroAddress
        ? 'Could not resolve this chain’s controller and authority.'
        : null,
  }
}

function valuesDiffer(values: (string | null)[]): boolean {
  if (values.length < 2) return false
  return new Set(values.map(value => value?.toLowerCase() ?? 'unset')).size > 1
}

/** The Edits-card outcome copy: executed counts shown, plural instruction. */
function outcomeMessage(
  result: Awaited<ReturnType<typeof runAuthorityCalls>>,
  completed: string,
): string {
  return safeOutcomeMessage(result, completed, {
    showExecuted: true,
    instruction: 'Complete queued actions in Pending multisig transactions.',
  })
}

export function AuthorityEditsCard({
  deployments,
  isRevnet,
  profile,
}: {
  deployments: AuthorityDeployment[]
  isRevnet: boolean
  profile: AuthorityEditProfile
}) {
  const query = useQuery({
    queryKey: [
      'authorityEditState',
      isRevnet,
      deployments
        .map(row => `${row.chainId}:${row.projectId}:${row.indexedAuthority ?? ''}`)
        .join(','),
    ],
    staleTime: 30_000,
    retry: 1,
    queryFn: () =>
      Promise.all(deployments.map(row => readEditState(row, isRevnet))),
  })
  const rows = query.data ?? []
  const [open, setOpen] = useState<'metadata' | 'token' | null>(null)
  const uriDiffers = valuesDiffer(rows.map(row => row.uri))
  const tokenDiffers = valuesDiffer(
    rows.map(row =>
      row.token
        ? `${row.token}:${row.tokenName ?? ''}:${row.tokenSymbol ?? ''}`
        : null,
    ),
  )

  return (
    <section className="card p-5">
      <span className="field-label">Edits</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        Everyday owner/operator changes. Review exactly which chains will
        change; EOAs sign per-chain requests and pay Relayr once, while Safe
        signers propose the same calls to each multisig.
      </p>

      {query.isLoading ? (
        <ActionRowsSkeleton rows={2} label="Loading editable project state" />
      ) : query.isError ? (
        <p className="mt-4 text-sm text-red-700">
          Could not load the editable project state.
        </p>
      ) : (
        <div className="mt-4 divide-y divide-smoke-100">
          <EditRow
            title="Set project metadata"
            description="Update the project’s name, logo, description, links, and public profile."
            differs={uriDiffers}
            actionLabel="Edit project"
            open={open === 'metadata'}
            onToggle={() => setOpen(current => (current === 'metadata' ? null : 'metadata'))}
          >
            <PerChainMetadataState rows={rows} differs={uriDiffers} />
            {open === 'metadata' ? (
              <MetadataEditor
                rows={rows}
                initial={profile}
                onCancel={() => setOpen(null)}
                onDone={() => query.refetch()}
              />
            ) : null}
          </EditRow>

          <EditRow
            title="Set token metadata"
            description="Set the token’s name and symbol, deploying the ERC-20 on chains that still use credits."
            differs={tokenDiffers}
            actionLabel="Edit token"
            open={open === 'token'}
            onToggle={() => setOpen(current => (current === 'token' ? null : 'token'))}
          >
            <PerChainTokenState rows={rows} differs={tokenDiffers} />
            {open === 'token' ? (
              <TokenEditor
                rows={rows}
                fallbackName={profile.name}
                onCancel={() => setOpen(null)}
                onDone={() => query.refetch()}
              />
            ) : null}
          </EditRow>

          <EditRow
            title="Set splits"
            description="Edit reserved-token recipients. Payout splits are edited per accounting token from the Rulesets tab."
            differs={false}
            actionLabel="Edit reserved splits"
            open={false}
            onToggle={() => {
              window.location.hash = isRevnet ? 'owners/splits' : 'rulesets'
            }}
          >
            <p className="mt-2 text-xs leading-relaxed text-smoke-500">
              Opens the live split editor, which preserves locked recipients and
              re-checks the group before saving.
            </p>
          </EditRow>
        </div>
      )}
    </section>
  )
}

function EditRow({
  title,
  description,
  differs,
  actionLabel,
  open,
  onToggle,
  children,
}: {
  title: string
  description: string
  differs: boolean
  actionLabel: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-ink">{title}</p>
            {differs ? (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                Differs by chain
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-smoke-700">
            {description}
          </p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="btn-secondary mt-3 min-h-[36px] px-3 text-xs"
        >
          {open ? 'Close' : actionLabel}
        </button>
      </div>
      {children}
    </div>
  )
}

/** "(same on all N chains)" suffix, MultiChainBuybackRouterCard style. */
function SameOnAllChains({ count }: { count: number }) {
  return (
    <span className="text-smoke-500">
      (same on all {count} chain{count === 1 ? '' : 's'})
    </span>
  )
}

function PerChainMetadataState({
  rows,
  differs,
}: {
  rows: EditChainState[]
  differs: boolean
}) {
  if (!differs && rows.length > 0) {
    const uri = rows[0].uri
    return (
      <p className="mt-3 text-xs text-smoke-700" title={uri ?? 'Not set'}>
        <span className="text-smoke-500">Current:</span>{' '}
        <span className={uri ? 'text-ink' : 'text-smoke-500'}>
          {uri ? truncateUri(uri) : 'Not set'}
        </span>{' '}
        <SameOnAllChains count={rows.length} />
      </p>
    )
  }
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
      {rows.map(row => (
        <span
          key={row.chainId}
          className="inline-flex min-w-0 items-center gap-1.5 text-xs text-smoke-500"
          title={row.uri ?? 'Not set'}
        >
          <ChainIcon chainId={row.chainId} size={16} standalone />
          {row.uri ? truncateUri(row.uri) : 'Not set'}
        </span>
      ))}
    </div>
  )
}

function PerChainTokenState({
  rows,
  differs,
}: {
  rows: EditChainState[]
  differs: boolean
}) {
  if (!differs && rows.length > 0) {
    const row = rows[0]
    return (
      <p className="mt-3 text-xs text-smoke-700">
        <span className="text-smoke-500">Current:</span>{' '}
        {row.token ? (
          <span className="text-ink" title={row.token}>
            {row.tokenName ?? 'Token'} · {row.tokenSymbol ?? '—'} ·{' '}
            <AddressLabel address={row.token} />
          </span>
        ) : (
          <span className="text-smoke-500">
            Credits only · ERC-20 not deployed
          </span>
        )}{' '}
        <SameOnAllChains count={rows.length} />
      </p>
    )
  }
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {rows.map(row => (
        <div
          key={row.chainId}
          className="flex min-w-0 items-center gap-2 rounded-lg bg-smoke-50 px-3 py-2"
        >
          <ChainIcon chainId={row.chainId} size={18} />
          <div className="min-w-0 text-xs">
            <p className="font-medium text-smoke-700">{row.name}</p>
            {row.token ? (
              <p className="truncate text-smoke-500" title={row.token}>
                {row.tokenName ?? 'Token'} · {row.tokenSymbol ?? '—'} ·{' '}
                <AddressLabel address={row.token} />
              </p>
            ) : (
              <p className="text-smoke-500">Credits only · ERC-20 not deployed</p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function truncateUri(uri: string): string {
  if (uri.length <= 30) return uri
  return `${uri.slice(0, 14)}…${uri.slice(-10)}`
}

/** The shared ChainPicker fed by this card's per-chain read state. */
function EditChainPicker({
  rows,
  selected,
  onChange,
  disabled,
}: {
  rows: EditChainState[]
  selected: Set<number>
  onChange: (next: Set<number>) => void
  disabled: boolean
}) {
  return (
    <ChainPicker
      label="Apply on"
      rows={rows.map(row => ({
        chainId: row.chainId,
        name: row.name,
        disabled: !!row.error,
        title: row.error ?? undefined,
      }))}
      selected={selected}
      onChange={onChange}
      disabled={disabled}
    />
  )
}

export function MetadataEditor({
  rows,
  initial,
  onCancel,
  onDone,
}: {
  rows: EditChainState[]
  initial: AuthorityEditProfile
  onCancel: () => void
  onDone: () => void
}) {
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(rows.filter(row => !row.error).map(row => row.chainId)),
  )
  const [name, setName] = useState(initial.name)
  const [tagline, setTagline] = useState(initial.tagline)
  const [description, setDescription] = useState(initial.description)
  const [infoUri, setInfoUri] = useState(initial.infoUri ?? '')
  const [twitter, setTwitter] = useState(initial.twitter ?? '')
  const [discord, setDiscord] = useState(initial.discord ?? '')
  const [telegram, setTelegram] = useState(initial.telegram ?? '')
  const [whatsapp, setWhatsapp] = useState(initial.whatsapp ?? '')
  const [instagram, setInstagram] = useState(initial.instagram ?? '')
  const [payNotice, setPayNotice] = useState(initial.payDisclosure ?? '')
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  // The Advanced box holds the metadata's UNRECOGNIZED keys as JSON. It only
  // replaces them once the user has actually edited it, so a save made before
  // the live JSON lands (or with the box never opened) preserves them.
  const [customText, setCustomText] = useState('')
  const [customTouched, setCustomTouched] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The CURRENT pinned projectUri JSON. Saving merges the edited fields into
  // this object so tags and custom fields round-trip untouched; the fetch is
  // repeated at pin time (fail-closed) if this read hasn't landed yet.
  const metadataUri = rows.find(row => row.uri)?.uri ?? null
  const currentMetadata = useQuery({
    queryKey: ['authorityEditCurrentUriJson', metadataUri],
    enabled: !!metadataUri,
    staleTime: 60_000,
    retry: 1,
    queryFn: () => fetchProjectMetadataJson(metadataUri!),
  })
  const otherKeys = preservedMetadataKeys(currentMetadata.data ?? null)
  const customLoading = !!metadataUri && currentMetadata.isLoading
  // A blank box after a failed read would read as "no custom properties" —
  // say so instead, and keep it locked (the save fails closed anyway).
  const customUnreadable = !!metadataUri && currentMetadata.isError
  const parsedCustom = parseCustomProperties(customText)

  // Prefill from the live JSON, and stop as soon as the user owns the box.
  useEffect(() => {
    if (customTouched) return
    setCustomText(customPropertiesText(currentMetadata.data ?? null))
  }, [currentMetadata.data, customTouched])

  useEffect(
    () => () => {
      if (logoPreview) URL.revokeObjectURL(logoPreview)
    },
    [logoPreview],
  )

  const invalidate = () => {
    setReviewed(false)
    setError(null)
  }

  const chooseLogo = (file: File | null) => {
    if (logoPreview) URL.revokeObjectURL(logoPreview)
    setLogoPreview(null)
    setLogoFile(null)
    invalidate()
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file for the logo.')
      return
    }
    if (file.size > MAX_LOGO_BYTES) {
      setError('Logos must be under 1 MB.')
      return
    }
    setLogoFile(file)
    setLogoPreview(URL.createObjectURL(file))
  }

  const review = () => {
    setError(null)
    if (!name.trim()) {
      setError('Give the project a name.')
      return
    }
    if (!selected.size) {
      setError('Choose at least one chain.')
      return
    }
    if (!parsedCustom.ok) {
      setError(parsedCustom.error)
      return
    }
    setReviewed(true)
  }

  const pinMetadata = async (): Promise<string> => {
    // Re-parse rather than trust the reviewed state: an unparseable box must
    // never reach the pin, and the user's JSON is never silently dropped.
    const custom = parseCustomProperties(customText)
    if (!custom.ok) throw new Error(custom.error)

    let logoUri = initial.logoUri ?? undefined
    if (logoFile) {
      setStatus('Uploading the logo…')
      const form = new FormData()
      form.append('file', logoFile)
      const response = await fetch('/api/ipfs/pin-file', {
        method: 'POST',
        body: form,
      })
      const body = (await response.json()) as { cid?: string; error?: string }
      if (!response.ok || !body.cid) {
        throw new Error(body.error ?? 'Logo upload failed.')
      }
      logoUri = `ipfs://${body.cid}`
    }

    // Merge over the CURRENT pinned JSON so fields this form doesn't edit —
    // tags, coverImageUri, custom fields — survive the save. If the project
    // has a uri that can't be read right now, fail the save rather than
    // silently rebuilding the profile from only the known fields.
    setStatus('Reading the current profile…')
    const existing = metadataUri
      ? (currentMetadata.data ?? (await fetchProjectMetadataJson(metadataUri)))
      : {}

    setStatus('Pinning the project profile…')
    const response = await fetch('/api/ipfs/pin-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        mergeProjectMetadata(
          existing,
          {
            name: name.trim(),
            projectTagline: tagline.trim(),
            description: description.trim(),
            infoUri: infoUri.trim(),
            twitter: twitter.trim(),
            discord: discord.trim(),
            telegram: telegram.trim(),
            whatsapp: whatsapp.trim(),
            instagram: instagram.trim(),
            payDisclosure: payNotice.trim(),
            // Only ever set or keep a logo — there's no removal control here.
            ...(logoUri ? { logoUri } : {}),
          },
          // An untouched box leaves the existing custom properties alone; an
          // edited one replaces them, so a removed key is removed on-chain.
          customTouched ? custom.properties : undefined,
        ),
      ),
    })
    const body = (await response.json()) as { cid?: string; error?: string }
    if (!response.ok || !body.cid) {
      throw new Error(body.error ?? 'Could not pin the project profile.')
    }
    return `ipfs://${body.cid}`
  }

  const submit = async () => {
    if (!reviewed || busy) return
    const chosen = rows.filter(row => selected.has(row.chainId))
    setBusy(true)
    setError(null)
    try {
      const uri = await pinMetadata()
      const calls: AuthorityCall[] = chosen.map(row => {
        if (!row.authority || !row.controller) {
          throw new Error(`${row.name}: owner/operator or controller is unknown.`)
        }
        return {
          chainId: row.chainId,
          authority: row.authority,
          target: row.controller,
          data: encodeFunctionData({
            abi: jbControllerAbi,
            functionName: 'setUriOf',
            args: [BigInt(row.projectId), uri],
          }),
          abi: jbControllerAbi,
          functionName: 'setUriOf',
          args: [BigInt(row.projectId), uri],
          contractName: 'JBController',
          gas: 250_000n,
          label: 'Set project metadata',
        }
      })
      const result = await runAuthorityCalls({
        calls,
        onProgress: progress => setStatus(progress.message),
      })
      setStatus(
        outcomeMessage(
          result,
          `Project metadata updated on ${calls.length} chain${
            calls.length === 1 ? '' : 's'
          }.`,
        ),
      )
      onDone()
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Could not update project metadata.',
      )
    } finally {
      setBusy(false)
    }
  }

  const preview = logoPreview ?? projectLogoUrl(initial.logoUri)

  return (
    <div className="mt-4 rounded-xl border border-smoke-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink">Edit project metadata</p>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-xs text-smoke-700 hover:text-ink"
        >
          Cancel
        </button>
      </div>

      <div className="mt-4">
        <EditChainPicker
          rows={rows}
          selected={selected}
          onChange={next => {
            setSelected(next)
            invalidate()
          }}
          disabled={busy}
        />
      </div>

      <div className="mt-4 grid gap-4">
        <TextField
          label="Name"
          value={name}
          onChange={value => {
            setName(value.slice(0, 100))
            invalidate()
          }}
          disabled={busy}
          required
        />
        <TextField
          label="Tagline"
          value={tagline}
          onChange={value => {
            setTagline(value.slice(0, 100))
            invalidate()
          }}
          disabled={busy}
          placeholder="One line about the project"
        />
        <label className="block">
          <span className="field-label">Description</span>
          <textarea
            value={description}
            onChange={event => {
              setDescription(event.target.value.slice(0, 5000))
              invalidate()
            }}
            disabled={busy}
            rows={4}
            className="input-well mt-1.5 w-full resize-y px-3 py-2.5 text-sm leading-relaxed disabled:opacity-60"
          />
        </label>
        <label className="block">
          <span className="field-label">Payment notice</span>
          <textarea
            value={payNotice}
            onChange={event => {
              setPayNotice(event.target.value.slice(0, 1000))
              invalidate()
            }}
            disabled={busy}
            rows={2}
            placeholder="Shown to payers before they pay"
            className="input-well mt-1.5 w-full resize-y px-3 py-2.5 text-sm leading-relaxed disabled:opacity-60"
          />
        </label>
      </div>

      <div className="mt-4">
        <span className="field-label">Logo</span>
        <div className="mt-2 flex items-center gap-3">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt="Logo preview"
              className="h-14 w-14 rounded-lg border border-smoke-200 object-cover"
            />
          ) : (
            <span className="flex h-14 w-14 items-center justify-center rounded-lg border border-dashed border-smoke-300 text-lg">
              🧃
            </span>
          )}
          <label className="btn-secondary min-h-[36px] cursor-pointer px-3 text-xs">
            {preview ? 'Change logo' : 'Upload logo'}
            <input
              type="file"
              accept="image/*"
              disabled={busy}
              className="sr-only"
              onChange={event => chooseLogo(event.target.files?.[0] ?? null)}
            />
          </label>
        </div>
      </div>

      <details className="mt-4 rounded-lg border border-smoke-200 p-3">
        <summary className="cursor-pointer text-sm font-medium text-ink">
          Links
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {[
            ['Website', infoUri, setInfoUri],
            ['X / Twitter', twitter, setTwitter],
            ['Discord', discord, setDiscord],
            ['Telegram', telegram, setTelegram],
            ['WhatsApp', whatsapp, setWhatsapp],
            ['Instagram', instagram, setInstagram],
          ].map(([label, value, setter]) => (
            <TextField
              key={label as string}
              label={label as string}
              value={value as string}
              onChange={next => {
                ;(setter as (value: string) => void)(next.slice(0, 300))
                invalidate()
              }}
              disabled={busy}
              placeholder="https://… or handle"
            />
          ))}
        </div>
      </details>

      <details className="mt-4 rounded-lg border border-smoke-200 p-3">
        <summary className="cursor-pointer text-sm font-medium text-ink">
          Advanced — custom properties (JSON)
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-smoke-500">
          Anything in this project&apos;s metadata that no field above owns.
          Saving replaces this set exactly: remove a property here and it is
          removed on-chain.
        </p>
        <textarea
          aria-label="Custom properties (JSON)"
          value={customText}
          onChange={event => {
            setCustomText(event.target.value)
            setCustomTouched(true)
            invalidate()
          }}
          disabled={busy || customLoading || customUnreadable}
          rows={6}
          spellCheck={false}
          placeholder={
            customLoading || customUnreadable ? '' : '{\n  "leagueID": 42\n}'
          }
          className="input-well mt-2 w-full resize-y px-3 py-2.5 font-mono text-xs leading-relaxed disabled:opacity-60"
        />
        {customLoading ? (
          <p className="mt-2 text-xs text-smoke-500">
            Loading this project&apos;s current custom properties…
          </p>
        ) : customUnreadable ? (
          <p className="mt-2 text-xs text-red-700">
            This project&apos;s current metadata could not be read, so its
            custom properties are unknown. A save retries the read and fails
            if it still can&apos;t load.
          </p>
        ) : null}
        {!parsedCustom.ok ? (
          <p className="mt-2 text-xs text-red-700">{parsedCustom.error}</p>
        ) : parsedCustom.collisions.length > 0 ? (
          <p className="mt-2 text-xs text-smoke-500">
            The form above owns {parsedCustom.collisions.join(', ')}, so{' '}
            {parsedCustom.collisions.length === 1 ? 'it is' : 'they are'}{' '}
            ignored here.
          </p>
        ) : null}
        {otherKeys.length > 0 ? (
          <p className="mt-2 text-xs text-smoke-500">
            Also kept as-is: {otherKeys.join(', ')}
          </p>
        ) : null}
      </details>

      {reviewed ? (
        <div className="callout callout-info mt-4 text-xs">
          <p>
            <span className="font-medium">{name.trim()}</span> will use one
            pinned profile on {rows
              .filter(row => selected.has(row.chainId))
              .map(row => row.name)
              .join(', ')}.
          </p>
        </div>
      ) : null}

      <button
        type="button"
        onClick={reviewed ? submit : review}
        disabled={busy || !name.trim() || !selected.size}
        className="btn-primary mt-4 min-h-[44px] w-full text-sm"
      >
        {busy ? status ?? 'Preparing…' : reviewed ? 'Save project metadata' : 'Review changes'}
      </button>
      {status ? <p className="mt-2 text-xs text-smoke-700">{status}</p> : null}
      {error ? <ErrorNote message={error} /> : null}
    </div>
  )
}

/**
 * The one CREATE2 salt every `deployERC20For` in a review shares, so all the
 * chains of a project land the token on the SAME address (the ecosystem's
 * omnichain ERC-20 convention). It anchors on the metadata of a token the
 * project already holds on some chain when there is one, so extending onto a
 * new chain reproduces the original address even after a rename.
 */
export function tokenDeploySalt(
  rows: readonly {
    token: Address | null
    tokenName: string | null
    tokenSymbol: string | null
  }[],
  name: string,
  symbol: string,
): Hex {
  const deployed = rows.find(row => row.token && row.tokenName && row.tokenSymbol)
  return omnichainTokenSalt(
    deployed?.tokenName ?? name,
    deployed?.tokenSymbol ?? symbol,
  )
}

function TokenEditor({
  rows,
  fallbackName,
  onCancel,
  onDone,
}: {
  rows: EditChainState[]
  fallbackName: string
  onCancel: () => void
  onDone: () => void
}) {
  const commonName =
    rows.find(row => row.tokenName)?.tokenName ?? fallbackName
  const commonSymbol = rows.find(row => row.tokenSymbol)?.tokenSymbol ?? ''
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(rows.filter(row => !row.error).map(row => row.chainId)),
  )
  const [name, setName] = useState(commonName)
  const [symbol, setSymbol] = useState(commonSymbol)
  const [review, setReview] = useState<AuthorityCall[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const invalidate = () => {
    setReview(null)
    setError(null)
  }

  const buildReview = () => {
    setError(null)
    const chosen = rows.filter(row => selected.has(row.chainId))
    if (!chosen.length) {
      setError('Choose at least one chain.')
      return
    }
    if (!name.trim()) {
      setError('Give the token a name.')
      return
    }
    if (!TOKEN_SYMBOL_RE.test(symbol)) {
      setError('Symbols are 1–8 uppercase letters or digits.')
      return
    }
    try {
      const salt = tokenDeploySalt(rows, name, symbol)
      setReview(
        chosen.map(row => {
          if (!row.authority || !row.controller) {
            throw new Error(`${row.name}: owner/operator or controller is unknown.`)
          }
          if (row.token) {
            return buildTokenMetadataAuthorityCall({
              chainId: row.chainId,
              authority: row.authority,
              controller: row.controller,
              projectId: BigInt(row.projectId),
              name: name.trim(),
              symbol,
            })
          }
          return buildDeployTokenAuthorityCall({
            chainId: row.chainId,
            authority: row.authority,
            controller: row.controller,
            projectId: BigInt(row.projectId),
            name: name.trim(),
            symbol,
            salt,
          })
        }),
      )
    } catch (reviewError) {
      setError(
        reviewError instanceof Error
          ? reviewError.message
          : 'Could not review token metadata.',
      )
    }
  }

  const submit = async () => {
    if (!review || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await runAuthorityCalls({
        calls: review,
        onProgress: progress => setStatus(progress.message),
      })
      setStatus(
        outcomeMessage(
          result,
          `Token metadata updated on ${review.length} chain${
            review.length === 1 ? '' : 's'
          }.`,
        ),
      )
      onDone()
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Could not update token metadata.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-smoke-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink">Edit token</p>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-xs text-smoke-700 hover:text-ink"
        >
          Cancel
        </button>
      </div>

      <div className="mt-4">
        <EditChainPicker
          rows={rows}
          selected={selected}
          onChange={next => {
            setSelected(next)
            invalidate()
          }}
          disabled={busy}
        />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_9rem]">
        <TextField
          label="Token name"
          value={name}
          onChange={value => {
            setName(value.slice(0, 100))
            invalidate()
          }}
          disabled={busy}
          required
        />
        <TextField
          label="Symbol"
          value={symbol}
          onChange={value => {
            setSymbol(
              value
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '')
                .slice(0, 8),
            )
            invalidate()
          }}
          disabled={busy}
          required
        />
      </div>

      {review ? (
        <div className="callout callout-info mt-4 text-xs">
          <p className="font-medium">Review per-chain behavior</p>
          <ul className="mt-2 space-y-1">
            {rows
              .filter(row => selected.has(row.chainId))
              .map(row => (
                <li key={row.chainId} className="flex items-center gap-2">
                  <ChainIcon chainId={row.chainId} size={16} />
                  {row.name}: {row.token ? 'rename existing token' : 'deploy ERC-20'}
                </li>
              ))}
          </ul>
          <p className="mt-2">
            Final metadata: <span className="font-medium">{name.trim()}</span>{' '}
            ({symbol}). Existing balances are unchanged.
          </p>
          {review.some(call => call.functionName === 'deployERC20For') ? (
            <p className="mt-2">
              Every deploy here uses the same salt, so the ERC-20 lands on one
              address across the chains you sign from this account.
            </p>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        onClick={review ? submit : buildReview}
        disabled={busy || !name.trim() || !TOKEN_SYMBOL_RE.test(symbol) || !selected.size}
        className="btn-primary mt-4 min-h-[44px] w-full text-sm"
      >
        {busy ? status ?? 'Preparing…' : review ? 'Save token metadata' : 'Review changes'}
      </button>
      {status ? <p className="mt-2 text-xs text-smoke-700">{status}</p> : null}
      {error ? <ErrorNote message={error} /> : null}
    </div>
  )
}

function TextField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
  required,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
  placeholder?: string
  required?: boolean
}) {
  return (
    <label className="block">
      <span className="field-label">
        {label}
        {required ? <span className="ml-1 text-peel-500">*</span> : null}
      </span>
      <input
        type="text"
        value={value}
        onChange={event => onChange(event.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="input-well mt-1.5 min-h-[42px] w-full px-3 text-sm disabled:opacity-60"
      />
    </label>
  )
}
