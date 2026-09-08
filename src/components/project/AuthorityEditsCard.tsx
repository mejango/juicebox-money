'use client'

import {
  JBCoreContracts,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbProjectsAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { getAccount } from '@wagmi/core'
import { getTokenAddress, hasPermissions, JBPermissionIdsV6 } from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  encodeFunctionData,
  erc20Abi,
  isAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { ChainIcon } from '@/components/ChainIcon'
import { ActionRowsSkeleton } from '@/components/LoadingSkeletons'
import { AddressLabel } from '@/components/ui/AddressLabel'
import type { AuthorityDeployment } from '@/components/project/AuthorityOverview'
import { replaceProjectTabHash } from '@/components/project/Tabs'
import { ChainPicker } from '@/components/ui/ChainPicker'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
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
  customMetadataProperties,
  fetchProjectMetadataJson,
  mergeProjectMetadata,
  parseCustomProperties,
  preservedMetadataKeys,
  type EditedMetadataKey,
} from '@/lib/project-metadata'
import { loadRelayrPendingSession, relayrCallsScope, resumeRelayrSession, withRelayrScopeLock } from '@/lib/relayr'
import { wagmiConfig } from '@/providers/Providers'
import { readAuthorityIdentity } from '@/lib/cross-chain-authority'
import {
  buildDeployTokenAuthorityCall,
  buildTokenMetadataAuthorityCall,
} from '@/lib/transaction-builders'
import { chainName } from '@/lib/urn'
import {
  JBCENTER_MAX_IMAGE_BYTES,
  jbCenterIpfs,
} from '@/lib/jbcenter-ipfs'

const MAX_LOGO_BYTES = JBCENTER_MAX_IMAGE_BYTES

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
                isRevnet={isRevnet}
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
              replaceProjectTabHash(
                isRevnet ? '#owners/splits' : '#rulesets',
              )
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
            {row.tokenName ?? 'Token'} | {row.tokenSymbol ?? '—'} |{' '}
            <AddressLabel address={row.token} />
          </span>
        ) : (
          <span className="text-smoke-500">
            Credits only | ERC-20 not deployed
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
                {row.tokenName ?? 'Token'} | {row.tokenSymbol ?? '—'} |{' '}
                <AddressLabel address={row.token} />
              </p>
            ) : (
              <p className="text-smoke-500">Credits only | ERC-20 not deployed</p>
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

/** A review-row value: blank reads as unset, long text is clipped. */
function reviewValue(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return '—'
  return trimmed.length > 48 ? `${trimmed.slice(0, 45)}…` : trimmed
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

type MetadataDestination = {
  chainId: JBChainId
  projectId: number
  indexedAuthority: Address | null
  owner: Address
  authority: Address
  controller: Address
  uri: string
  nextUri: string
}

type MetadataReview = {
  account: Address
  isRevnet: boolean
  scope: string
  destinations: MetadataDestination[]
  rows: TxConfirmRow[]
}

const metadataReviewKey = (row: { chainId: number; projectId: number }) =>
  `jb-metadata-review-v1:${row.chainId}:${row.projectId}`

async function withMetadataReviewLocks<T>(
  rows: readonly { chainId: number; projectId: number }[],
  execute: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(rows.map(metadataReviewKey))].sort()
  const lock = (index: number): Promise<T> => index === keys.length
    ? execute()
    : withRelayrScopeLock(keys[index], () => lock(index + 1))
  return lock(0)
}

async function readMetadataBaseline(deployment: AuthorityDeployment, isRevnet: boolean, account: Address) {
  const client = clientFor(deployment.chainId)
  const [owner, controller] = await Promise.all([
    client.readContract({ address: jbContractAddress['6'][JBCoreContracts.JBProjects][deployment.chainId],
      abi: jbProjectsAbi, functionName: 'ownerOf', args: [BigInt(deployment.projectId)] }),
    client.readContract({
      address: jbContractAddress['6'][JBCoreContracts.JBDirectory][deployment.chainId],
      abi: jbDirectoryAbi, functionName: 'controllerOf', args: [BigInt(deployment.projectId)],
    }),
  ])
  if (!isAddress(owner) || !isAddress(controller) || isAddressEqual(controller, zeroAddress)) {
    throw new Error(`${chainName(deployment.chainId)}: could not verify the live controller and authority.`)
  }
  const permitted = (operator: Address) => hasPermissions(client, {
    chainId: deployment.chainId, account: owner, operator,
    projectId: BigInt(deployment.projectId), permissionIds: [JBPermissionIdsV6.SET_PROJECT_URI],
    includeRoot: true, includeWildcardProjectId: true,
  })
  const candidates = [owner]
  const indexed = await readAuthorityOf(client, deployment, { indexedOnly: isRevnet, detectRevnet: !isRevnet, strict: true })
  if (indexed && !isAddressEqual(indexed, owner)) candidates.push(indexed)
  let authority: Address | null = null
  for (const candidate of candidates) {
    const identity = isAddressEqual(account, candidate) ? null : await readAuthorityIdentity(client, candidate)
    const canSign = isAddressEqual(account, candidate) ||
      (identity?.kind === 'safe' && identity.owners.some(signer => isAddressEqual(signer, account)))
    if (canSign && (isAddressEqual(candidate, owner) || await permitted(candidate))) {
      authority = candidate
      break
    }
  }
  if (!authority && await permitted(account)) authority = account
  if (!authority) throw new Error(`${chainName(deployment.chainId)}: this wallet cannot set the project metadata URI.`)
  const uri = await client.readContract({ address: controller, abi: jbControllerAbi,
    functionName: 'uriOf', args: [BigInt(deployment.projectId)] })
  if (typeof uri !== 'string') throw new Error('Could not read the current project metadata URI.')
  return { owner, authority, controller, uri }
}

function metadataReviewCalls(review: MetadataReview, requireSaved = true): AuthorityCall[] {
  return review.destinations.map(destination => ({
    chainId: destination.chainId,
    authority: destination.authority,
    target: destination.controller,
    data: encodeFunctionData({ abi: jbControllerAbi, functionName: 'setUriOf',
      args: [BigInt(destination.projectId), destination.nextUri] }),
    abi: jbControllerAbi,
    functionName: 'setUriOf',
    args: [BigInt(destination.projectId), destination.nextUri],
    contractName: 'JBController',
    gas: 250_000n,
    label: `Set project ${destination.projectId} metadata`,
    reverifyAuthority: async () => {
      const connected = getAccount(wagmiConfig).address
      if (!connected || !isAddressEqual(connected, review.account)) throw new Error('Connect the wallet that reviewed this metadata update.')
      if (requireSaved && typeof window !== 'undefined') {
        const saved = readMetadataReview([destination])
        if (!saved || saved.scope !== review.scope || !isAddressEqual(saved.account, review.account)) {
          throw new Error('The original metadata review changed in another tab. Reopen the saved review before continuing.')
        }
      }
      const live = await readMetadataBaseline(destination, review.isRevnet, review.account)
      if (!isAddressEqual(live.owner, destination.owner) || !isAddressEqual(live.authority, destination.authority) ||
          !isAddressEqual(live.controller, destination.controller) || live.uri !== destination.uri) {
        throw new Error(`${chainName(destination.chainId)}: the controller, authority, or metadata URI changed after review. The original metadata update was not sent.`)
      }
    },
  }))
}

function readMetadataReview(rows: readonly { chainId: number; projectId: number }[]): MetadataReview | null {
  if (typeof window === 'undefined') return null
  for (const row of rows) {
    try {
      const raw = window.localStorage.getItem(metadataReviewKey(row))
      if (!raw) continue
      const review = JSON.parse(raw) as MetadataReview
      if (!isAddress(review.account) || !Array.isArray(review.destinations) || !review.destinations.length ||
          review.destinations.length > 16 || typeof review.isRevnet !== 'boolean' || !Array.isArray(review.rows) ||
          review.rows.some(item => !item || typeof item.label !== 'string' || typeof item.value !== 'string') ||
          !review.destinations.some(item => item.chainId === row.chainId && item.projectId === row.projectId) ||
          review.destinations.some(item => !Number.isSafeInteger(item.chainId) || item.chainId < 1 ||
            !Number.isSafeInteger(item.projectId) || item.projectId < 1 || !isAddress(item.owner) || !isAddress(item.authority) ||
            !isAddress(item.controller) || typeof item.uri !== 'string' || typeof item.nextUri !== 'string') ||
          review.scope !== relayrCallsScope(metadataReviewCalls(review))) continue
      return review
    } catch { /* An invalid local review cannot authorize a transaction. */ }
  }
  return null
}

function saveMetadataReview(review: MetadataReview): void {
  if (typeof window === 'undefined') return
  const text = JSON.stringify(review)
  for (const destination of review.destinations) {
    const previous = readMetadataReview([destination])
    if (previous && (previous.scope !== review.scope || !isAddressEqual(previous.account, review.account))) {
      throw new Error('Finish or close the original metadata review before reviewing another update for this project.')
    }
    window.localStorage.setItem(metadataReviewKey(destination), text)
    if (window.localStorage.getItem(metadataReviewKey(destination)) !== text) {
      throw new Error('Allow browser storage before submitting this metadata update.')
    }
  }
}

async function clearMetadataReview(review: MetadataReview): Promise<void> {
  return withMetadataReviewLocks(review.destinations, async () => {
    if (loadRelayrPendingSession(review.scope)) {
      throw new Error('The original metadata authorizations are already published. Resume that saved update before changing it.')
    }
    removeMetadataReview(review)
  })
}

function removeMetadataReview(review: MetadataReview): void {
  if (typeof window === 'undefined') return
  for (const destination of review.destinations) {
    if (readMetadataReview([destination])?.scope === review.scope) window.localStorage.removeItem(metadataReviewKey(destination))
  }
}

/** Stable JSON identity makes equivalent per-chain metadata share a single pin. */
function metadataJsonKey(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
      : item)
}

export function MetadataEditor({
  rows,
  isRevnet = false,
  initial,
  onCancel,
  onDone,
}: {
  rows: EditChainState[]
  isRevnet?: boolean
  initial: AuthorityEditProfile
  onCancel: () => void
  onDone: () => void
}) {
  const [selected, setSelected] = useState<Set<number>>(
    // Metadata-only delegates need not be the indexed full revnet operator.
    // The live setter-specific permission check runs while building the review.
    () => new Set(rows.filter(row => !!row.controller).map(row => row.chainId)),
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
  // Compare the Advanced box with its own prefill so edits affect the same
  // custom keys everywhere while preserving unrelated per-chain properties.
  const [customText, setCustomText] = useState('')
  const [customBaseline, setCustomBaseline] = useState<Record<string, unknown>>({})
  const [customTouched, setCustomTouched] = useState(false)
  const [frozen, setFrozen] = useState<MetadataReview | null>(() => readMetadataReview(rows))
  const [reviewed, setReviewed] = useState(!!frozen)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // This first-chain read only prefills the optional custom-property replacement.
  // Each destination's live URI is read separately when building the review.
  const metadataSource = rows.find(row => row.uri)
  const metadataUri = metadataSource?.uri ?? null
  const currentMetadata = useQuery({
    queryKey: ['authorityEditCurrentUriJson', metadataUri],
    enabled: !!metadataUri && !frozen,
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
    setCustomBaseline(customMetadataProperties(currentMetadata.data ?? null))
  }, [currentMetadata.data, customTouched])

  useEffect(
    () => () => {
      if (logoPreview) URL.revokeObjectURL(logoPreview)
    },
    [logoPreview],
  )

  const locked = !!frozen && !!loadRelayrPendingSession(frozen.scope)

  const invalidate = async () => {
    if (locked) return
    if (frozen) {
      try { await clearMetadataReview(frozen) }
      catch (invalidateError) {
        setError(invalidateError instanceof Error ? invalidateError.message : 'This metadata review is active in another tab.')
        return
      }
    }
    setFrozen(null)
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
      setError('Logos must be under 25 MB.')
      return
    }
    setLogoFile(file)
    setLogoPreview(URL.createObjectURL(file))
  }

  const chosen = rows.filter(row => selected.has(row.chainId))

  const review = async () => {
    if (busy) return
    setError(null)
    setStatus(null)
    if (frozen) { setReviewed(true); return }
    if (!name.trim()) { setError('Give the project a name.'); return }
    if (!chosen.length) { setError('Choose at least one chain.'); return }
    const custom = parseCustomProperties(customText)
    if (!custom.ok) { setError(custom.error); return }
    const account = getAccount(wagmiConfig).address
    if (!account) { setError('Connect a wallet first.'); return }
    setBusy(true)
    try {
      const pending = readMetadataReview(rows)
      if (pending && loadRelayrPendingSession(pending.scope)) {
        setFrozen(pending)
        setReviewed(true)
        return
      }
      const fields: [EditedMetadataKey, string, string, string][] = [
        ['name', 'Name', initial.name, name],
        ['projectTagline', 'Tagline', initial.tagline, tagline],
        ['description', 'Description', initial.description, description],
        ['payDisclosure', 'Payment notice', initial.payDisclosure ?? '', payNotice],
        ['infoUri', 'Website', initial.infoUri ?? '', infoUri],
        ['twitter', 'X / Twitter', initial.twitter ?? '', twitter],
        ['discord', 'Discord', initial.discord ?? '', discord],
        ['telegram', 'Telegram', initial.telegram ?? '', telegram],
        ['whatsapp', 'WhatsApp', initial.whatsapp ?? '', whatsapp],
        ['instagram', 'Instagram', initial.instagram ?? '', instagram],
      ]
      const changed = fields.filter(([, , before, after]) => before.trim() !== after.trim())
      const customKeys = customTouched ? [...new Set([
        ...Object.keys(customBaseline), ...Object.keys(custom.properties),
      ])].filter(key => !(key in customBaseline) || !(key in custom.properties) ||
        metadataJsonKey(customBaseline[key]) !== metadataJsonKey(custom.properties[key])) : []
      const edits: Partial<Record<EditedMetadataKey, string>> = Object.fromEntries(
        changed.map(([key, , , after]) => [key, after.trim()]),
      )
      if (logoFile) {
        setStatus('Uploading the logo…')
        edits.logoUri = (await jbCenterIpfs.pinImage(logoFile)).uri
      }
      const metadata = new Map<string, Promise<Record<string, unknown>>>()
      const pins = new Map<string, Promise<string>>()
      const destinations: MetadataDestination[] = []
      const confirmationRows: TxConfirmRow[] = []
      for (const row of chosen) {
        setStatus(`Reading the current profile on ${row.name}…`)
        const baseline = await readMetadataBaseline(row, isRevnet, account)
        if (destinations.length && !isAddressEqual(destinations[0].authority, baseline.authority)) {
          throw new Error('Choose chains controlled by the same owner/operator for one metadata update. Submit other authorities separately.')
        }
        let existing: Record<string, unknown> = {}
        if (baseline.uri) {
          if (!metadata.has(baseline.uri)) metadata.set(baseline.uri, fetchProjectMetadataJson(baseline.uri))
          existing = await metadata.get(baseline.uri)!
        }
        const nextCustom = customMetadataProperties(existing)
        for (const key of customKeys) {
          if (key in custom.properties) nextCustom[key] = custom.properties[key]
          else delete nextCustom[key]
        }
        const next = mergeProjectMetadata(existing, edits, customTouched ? nextCustom : undefined)
        const key = metadataJsonKey(next)
        if (!pins.has(key)) {
          setStatus(`Pinning the profile for ${row.name}…`)
          pins.set(key, jbCenterIpfs.pinJson(next).then(pin => pin.uri))
        }
        const nextUri = await pins.get(key)!
        destinations.push({ chainId: row.chainId, projectId: row.projectId,
          indexedAuthority: row.indexedAuthority, ...baseline, nextUri })
        confirmationRows.push({ label: row.name, value: `Project ${row.projectId} · ${baseline.controller}` })
        for (const [field, label, , after] of changed) {
          const before = typeof existing[field] === 'string' ? existing[field] as string : ''
          confirmationRows.push({ label: `${row.name} · ${label}`, value: `${reviewValue(before)} → ${reviewValue(after)}` })
        }
        if (logoFile) confirmationRows.push({ label: `${row.name} · Logo`, value: existing.logoUri ? 'Replaced' : 'Added' })
        for (const key of customKeys) confirmationRows.push({
          label: `${row.name} · Custom property ${key}`,
          value: key in custom.properties ? 'Set to the reviewed value' : 'Removed',
        })
        if (!changed.length && !logoFile && !customKeys.length) {
          confirmationRows.push({ label: `${row.name} · Fields`, value: 'Unchanged — this chain’s profile is re-pinned as is' })
        }
      }
      const nextReview: MetadataReview = { account, isRevnet, scope: '', destinations, rows: confirmationRows }
      nextReview.scope = relayrCallsScope(metadataReviewCalls(nextReview))
      // Every destination is rechecked after potentially slow metadata fetches and pins.
      for (const call of metadataReviewCalls(nextReview, false)) await call.reverifyAuthority?.()
      await withMetadataReviewLocks(nextReview.destinations, async () => saveMetadataReview(nextReview))
      setFrozen(nextReview)
      setReviewed(true)
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Could not review project metadata.')
    } finally { setBusy(false) }
  }

  const closeReview = async () => {
    if (frozen && !loadRelayrPendingSession(frozen.scope)) {
      try { await clearMetadataReview(frozen) }
      catch (closeError) {
        setError(closeError instanceof Error ? closeError.message : 'This metadata review is active in another tab.')
        return
      }
      setFrozen(null)
    }
    setReviewed(false)
    setDone(false)
    setError(null)
  }

  const submit = async () => {
    if (!reviewed || !frozen || busy) return
    setBusy(true)
    setError(null)
    try {
      await withMetadataReviewLocks(frozen.destinations, async () => {
        const account = getAccount(wagmiConfig).address
        if (!account || !isAddressEqual(account, frozen.account)) throw new Error('Connect the wallet that reviewed this metadata update.')
        const pending = loadRelayrPendingSession(frozen.scope)
        if (pending && pending.paymentStatus !== 'unpaid') {
          await resumeRelayrSession({ scope: frozen.scope, account, onProgress: progress => {
            if (progress.phase === 'executing') setStatus(`Relayr reports ${progress.done}/${progress.total} complete; checking the original receipts…`)
          } })
          setStatus(`Project metadata updated on ${frozen.destinations.length} chains.`)
        } else {
          saveMetadataReview(frozen)
          const calls = metadataReviewCalls(frozen)
          const result = await runAuthorityCalls({ calls, onProgress: progress => setStatus(progress.message) })
          setStatus(outcomeMessage(result, `Project metadata updated on ${calls.length} chain${calls.length === 1 ? '' : 's'}.`))
        }
        removeMetadataReview(frozen)
        setDone(true)
        onDone()
      })
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not update project metadata.')
    } finally { setBusy(false) }
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
          rows={rows.map(row => ({ ...row, error: row.controller ? null : row.error }))}
          selected={selected}
          onChange={next => {
            setSelected(next)
            invalidate()
          }}
          disabled={busy || locked}
        />
        <p className="mt-2 text-xs leading-relaxed text-smoke-500">
          Only fields you change are applied to every selected chain. Other
          values stay as they are on each chain.
        </p>
      </div>

      <div className="mt-4 grid gap-4">
        <TextField
          label="Name"
          value={name}
          onChange={value => {
            setName(value.slice(0, 100))
            invalidate()
          }}
          disabled={busy || locked}
          required
        />
        <TextField
          label="Tagline"
          value={tagline}
          onChange={value => {
            setTagline(value.slice(0, 100))
            invalidate()
          }}
          disabled={busy || locked}
          placeholder="One line about the project"
        />
        <label className="block">
          <span className="field-label">Description</span>
          <textarea
            value={description}
            onChange={event => {
              setDescription(event.target.value.slice(0, 10000))
              invalidate()
            }}
            disabled={busy || locked}
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
            disabled={busy || locked}
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
              disabled={busy || locked}
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
              disabled={busy || locked}
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
          {metadataSource ? `Prefilled from ${metadataSource.name}. ` : ''}
          Keys you add, change, or remove are updated on every selected chain.
          Unchanged keys and other chains&apos; extra custom properties are kept.
        </p>
        <textarea
          aria-label="Custom properties (JSON)"
          value={customText}
          onChange={event => {
            setCustomText(event.target.value)
            setCustomTouched(true)
            invalidate()
          }}
          disabled={busy || locked || customLoading || customUnreadable}
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

      <button
        type="button"
        onClick={() => void review()}
        disabled={busy || (!frozen && (!name.trim() || !selected.size))}
        className="btn-primary mt-4 min-h-[44px] w-full text-sm"
      >
        {locked ? 'Resume original metadata update' : 'Save project details'}
      </button>
      {status && !reviewed ? (
        <p className="mt-2 text-xs text-smoke-700">{status}</p>
      ) : null}
      {error && !reviewed ? <ErrorNote message={error} /> : null}

      {reviewed ? (
        <TxConfirmDialog
          open
          title={done ? 'Project metadata updated' : 'Confirm project metadata'}
          rows={frozen?.rows ?? []}
          steps={(frozen?.destinations ?? []).map(row => ({
            key: String(row.chainId),
            title: `Set project metadata on ${chainName(row.chainId)}`,
          }))}
          activeIndex={busy ? 0 : -1}
          status={status}
          error={error}
          busy={busy}
          complete={done}
          action={error ? 'Retry' : 'Confirm & save'}
          onConfirm={() => void submit()}
          onClose={closeReview}
        />
      ) : null}
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
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const invalidate = () => {
    setReview(null)
    setDone(false)
    setError(null)
  }

  const buildReview = () => {
    setError(null)
    setStatus(null)
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
      setDone(true)
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

      <button
        type="button"
        onClick={buildReview}
        disabled={busy || !name.trim() || !TOKEN_SYMBOL_RE.test(symbol) || !selected.size}
        className="btn-primary mt-4 min-h-[44px] w-full text-sm"
      >
        Save token details
      </button>
      {status && !review ? (
        <p className="mt-2 text-xs text-smoke-700">{status}</p>
      ) : null}
      {error && !review ? <ErrorNote message={error} /> : null}

      {review ? (
        <TxConfirmDialog
          open
          title={done ? 'Token metadata updated' : 'Confirm token metadata'}
          rows={[
            {
              label: 'Name',
              value:
                commonName === name.trim()
                  ? name.trim()
                  : `${reviewValue(commonName)} → ${name.trim()}`,
            },
            {
              label: 'Symbol',
              value:
                commonSymbol === symbol
                  ? symbol
                  : `${reviewValue(commonSymbol)} → ${symbol}`,
            },
            {
              label: 'On',
              value: review.map(call => chainName(call.chainId)).join(', '),
            },
          ]}
          steps={review.map(call => ({
            key: String(call.chainId),
            title: `${
              call.functionName === 'deployERC20For'
                ? 'Deploy the ERC-20'
                : 'Rename the token'
            } on ${chainName(call.chainId)}`,
          }))}
          activeIndex={busy ? 0 : -1}
          status={status}
          error={error}
          busy={busy}
          complete={done}
          action={error ? 'Retry' : 'Confirm & save'}
          onConfirm={() => void submit()}
          onClose={invalidate}
        >
          <p className="text-xs leading-relaxed text-smoke-700">
            Existing balances are unchanged.
            {review.some(call => call.functionName === 'deployERC20For')
              ? ' Every deploy uses the same salt, so the ERC-20 lands on one address across the chains you sign from this account.'
              : ''}
          </p>
        </TxConfirmDialog>
      ) : null}
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
