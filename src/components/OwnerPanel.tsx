'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  jbContractAddress,
  jbDirectoryAbi,
  jbProjectsAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { getTokenAddress } from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { BaseError, erc20Abi, type PublicClient } from 'viem'
import {
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { useWallet } from '@/hooks/useWallet'
import { ipfsUrl, truncateAddress } from '@/lib/format'
import {
  buildDeployTokenRequest,
  buildSetUriTx,
  isKnownController,
} from '@/lib/manage'

const MAX_LOGO_BYTES = 1024 * 1024

/** The project's current metadata, for prefilling the edit form. */
export type OwnerPanelInitial = {
  name: string
  tagline: string
  description: string
  /** Current logo as an `ipfs://` URI, if any. */
  logoUri: string | null
  /** Carried forward untouched on save so edits never drop them. */
  infoUri?: string
  twitter?: string
  discord?: string
}

function friendlyError(e: unknown): string {
  const message =
    e instanceof BaseError
      ? e.shortMessage
      : e instanceof Error
        ? e.message
        : 'Something went wrong.'
  return /reject|denied|cancel/i.test(message)
    ? 'You cancelled in your wallet.'
    : message
}

/**
 * The owner's manage strip on the project page. Renders nothing unless the
 * connected wallet is the project's on-chain owner — `JBProjects.ownerOf` is
 * the truth (bendystraw's `owner` can lag a transfer), and nothing renders
 * until that read resolves, so there's no flicker for everyone else.
 */
export function OwnerPanel({
  chainId,
  projectId,
  initial,
}: {
  chainId: JBChainId
  projectId: number
  initial: OwnerPanelInitial
}) {
  const { isConnected, address } = useWallet()

  // Wallet state only exists client-side; keep SSR + first client render
  // identical (null) so hydration always matches.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const { data: owner } = useReadContract({
    abi: jbProjectsAbi,
    address: jbContractAddress['6'][JBCoreContracts.JBProjects][chainId],
    functionName: 'ownerOf',
    args: [BigInt(projectId)],
    chainId,
    query: { enabled: mounted && isConnected && !!address, staleTime: 60_000 },
  })

  const isOwner =
    mounted &&
    isConnected &&
    !!address &&
    !!owner &&
    owner.toLowerCase() === address.toLowerCase()

  // Owner actions go through the project's own controller. Only read once
  // the wallet IS the owner, and only render when it's the controller these
  // builders speak — a custom controller would just revert on both actions.
  const { data: controller } = useReadContract({
    abi: jbDirectoryAbi,
    address: jbContractAddress['6'][JBCoreContracts.JBDirectory][chainId],
    functionName: 'controllerOf',
    args: [BigInt(projectId)],
    chainId,
    query: { enabled: isOwner, staleTime: 60_000 },
  })

  if (!isOwner || !isKnownController(chainId, controller)) return null

  return (
    <section className="mb-10">
      <span className="silk-label">Owner</span>
      <div className="panel mt-1.5 divide-y-2 divide-frame">
        <DetailsRow
          chainId={chainId}
          projectId={projectId}
          initial={initial}
          controller={controller!}
        />
        <TokenRow
          chainId={chainId}
          projectId={projectId}
          projectName={initial.name}
          controller={controller!}
        />
      </div>
    </section>
  )
}

/** Row header: title + dim byline on the left, one pixel button on the right. */
function Row({
  title,
  byline,
  action,
  children,
}: {
  title: string
  byline: React.ReactNode
  action: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink">{title}</p>
          <p className="mt-0.5 text-xs text-dim">{byline}</p>
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

function RefreshHint() {
  return (
    <p className="mt-3 flex items-center gap-2 text-xs text-dim">
      <span className="chip bg-frame text-ink">Refresh</span>
      Saved onchain — this page picks it up in about a minute.
    </p>
  )
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p className="mt-3 rounded border-2 border-red-400/40 bg-well px-3 py-2 text-sm text-red-300">
      {message}
    </p>
  )
}

// ---------------------------------------------------------------- details --

function DetailsRow({
  chainId,
  projectId,
  initial,
  controller,
}: {
  chainId: JBChainId
  projectId: number
  initial: OwnerPanelInitial
  controller: `0x${string}`
}) {
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()

  const [open, setOpen] = useState(false)
  const [name, setName] = useState(initial.name)
  const [tagline, setTagline] = useState(initial.tagline)
  const [description, setDescription] = useState(initial.description)
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [phase, setPhase] = useState<'idle' | 'pinning' | 'signing'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()

  const receipt = useWaitForTransactionReceipt({ hash: txHash, chainId })
  const mining = !!txHash && receipt.isLoading
  const saved = !!txHash && receipt.isSuccess
  const busy = phase !== 'idle' || mining

  useEffect(
    () => () => {
      if (logoPreview) URL.revokeObjectURL(logoPreview)
    },
    [logoPreview],
  )

  const currentLogoUrl = logoPreview ?? ipfsUrl(initial.logoUri)

  const onLogoChange = (file: File | null) => {
    setLogoError(null)
    if (logoPreview) URL.revokeObjectURL(logoPreview)
    if (!file) {
      setLogoFile(null)
      setLogoPreview(null)
      return
    }
    if (!file.type.startsWith('image/')) {
      setLogoError('Please pick an image file.')
      return
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError('Logos must be under 1MB.')
      return
    }
    setLogoFile(file)
    setLogoPreview(URL.createObjectURL(file))
  }

  /** Pin the new logo (only if changed) then the merged metadata JSON. */
  const pinMetadata = async (): Promise<string> => {
    let logoUri = initial.logoUri ?? undefined
    if (logoFile) {
      const form = new FormData()
      form.append('file', logoFile)
      const res = await fetch('/api/ipfs/pin-file', { method: 'POST', body: form })
      const json = (await res.json()) as { cid?: string; error?: string }
      if (!res.ok || !json.cid) {
        throw new Error(json.error ?? 'Logo upload failed — try again.')
      }
      logoUri = `ipfs://${json.cid}`
    }
    const res = await fetch('/api/ipfs/pin-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        projectTagline: tagline.trim() || undefined,
        description: description.trim() || undefined,
        logoUri,
        infoUri: initial.infoUri,
        twitter: initial.twitter,
        discord: initial.discord,
      }),
    })
    const json = (await res.json()) as { cid?: string; error?: string }
    if (!res.ok || !json.cid) {
      throw new Error(json.error ?? 'Saving project details failed — try again.')
    }
    return `ipfs://${json.cid}`
  }

  const save = async () => {
    if (busy || !name.trim()) return
    setErrorMsg(null)
    try {
      setPhase('pinning')
      const projectUri = await pinMetadata()
      setPhase('signing')
      await switchChainAsync({ chainId })
      const request = buildSetUriTx({
        chainId,
        projectId: BigInt(projectId),
        projectUri,
        controller,
      })
      const hash = await writeContractAsync(request)
      setTxHash(hash)
    } catch (e) {
      setErrorMsg(friendlyError(e))
    } finally {
      setPhase('idle')
    }
  }

  const close = () => {
    setOpen(false)
    if (saved) return // Keep the edited values — they're now the truth.
    setName(initial.name)
    setTagline(initial.tagline)
    setDescription(initial.description)
    onLogoChange(null)
    setErrorMsg(null)
  }

  return (
    <Row
      title="Project details"
      byline="Name, tagline, description, logo."
      action={
        <button
          onClick={() => (open ? close() : setOpen(true))}
          className="btn-pixel min-h-[36px] shrink-0 px-4 text-[11px]"
        >
          {open ? 'Close' : 'Edit'}
        </button>
      }
    >
      {open ? (
        <div className="border-t-2 border-frame px-5 py-5">
          {saved ? (
            <div>
              <p className="text-sm font-bold text-lime">Details updated.</p>
              <RefreshHint />
            </div>
          ) : (
            <>
              <label className="block">
                <span className="silk-label">
                  Name <span className="text-juice">*</span>
                </span>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value.slice(0, 100))}
                  disabled={busy}
                  className="input-well mt-1.5 min-h-[48px] px-4 text-base font-semibold disabled:opacity-60"
                />
              </label>

              <label className="mt-4 block">
                <span className="flex items-baseline justify-between">
                  <span className="silk-label">Tagline</span>
                  <span className="text-xs text-dim">{tagline.length}/100</span>
                </span>
                <input
                  type="text"
                  value={tagline}
                  onChange={e => setTagline(e.target.value.slice(0, 100))}
                  disabled={busy}
                  placeholder="One line about your project"
                  className="input-well mt-1.5 min-h-[44px] px-4 text-sm disabled:opacity-60"
                />
              </label>

              <label className="mt-4 block">
                <span className="silk-label">Description</span>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value.slice(0, 5000))}
                  disabled={busy}
                  rows={4}
                  placeholder="Tell supporters what you're building and why it matters"
                  className="input-well mt-1.5 resize-y px-4 py-3 text-sm leading-relaxed disabled:opacity-60"
                />
              </label>

              <div className="mt-4">
                <span className="silk-label">Logo</span>
                <div className="mt-1.5 flex items-center gap-4">
                  {currentLogoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={currentLogoUrl}
                      alt="Logo preview"
                      className="h-16 w-16 rounded border-2 border-frame object-cover"
                    />
                  ) : (
                    <span className="flex h-16 w-16 items-center justify-center rounded border-2 border-dashed border-frame text-xl">
                      🧃
                    </span>
                  )}
                  <div>
                    <label className="btn-pixel min-h-[36px] cursor-pointer px-4 text-[11px]">
                      {logoFile || initial.logoUri ? 'Change image' : 'Upload image'}
                      <input
                        type="file"
                        accept="image/*"
                        disabled={busy}
                        className="sr-only"
                        onChange={e => onLogoChange(e.target.files?.[0] ?? null)}
                      />
                    </label>
                    {logoFile ? (
                      <button
                        onClick={() => onLogoChange(null)}
                        disabled={busy}
                        className="ml-3 font-pixel text-[11px] uppercase tracking-wider text-dim hover:text-ink"
                      >
                        Undo
                      </button>
                    ) : null}
                    <p className="mt-1.5 text-xs text-dim">
                      Square works best. Up to 1MB.
                    </p>
                    {logoError ? (
                      <p className="mt-1 text-xs text-red-400">{logoError}</p>
                    ) : null}
                  </div>
                </div>
              </div>

              <button
                onClick={save}
                disabled={busy || !name.trim()}
                className="btn-juice mt-5 min-h-[48px] w-full text-sm"
              >
                {phase === 'pinning'
                  ? 'Saving your details…'
                  : phase === 'signing'
                    ? 'Confirm in your wallet…'
                    : mining
                      ? 'Updating onchain…'
                      : 'Save changes'}
              </button>

              {errorMsg ? <ErrorNote message={errorMsg} /> : null}
            </>
          )}
        </div>
      ) : null}
    </Row>
  )
}

// ------------------------------------------------------------------ token --

function TokenRow({
  chainId,
  projectId,
  projectName,
  controller,
}: {
  chainId: JBChainId
  projectId: number
  projectName: string
  controller: `0x${string}`
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()

  const [open, setOpen] = useState(false)
  const [name, setName] = useState(projectName)
  const [symbol, setSymbol] = useState('')
  const [sending, setSending] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()

  const {
    data: token,
    isLoading: tokenLoading,
    refetch: refetchToken,
  } = useQuery({
    queryKey: ['ownerTokenAddress', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: () =>
      getTokenAddress(publicClient!, { chainId, projectId: BigInt(projectId) }),
  })

  const { data: tokenSymbol } = useQuery({
    queryKey: ['ownerTokenSymbol', chainId, token],
    enabled: !!publicClient && !!token,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: () =>
      publicClient!.readContract({
        address: token!,
        abi: erc20Abi,
        functionName: 'symbol',
      }),
  })

  const receipt = useWaitForTransactionReceipt({ hash: txHash, chainId })
  const mining = !!txHash && receipt.isLoading
  const deployed = !!txHash && receipt.isSuccess

  useEffect(() => {
    if (deployed) refetchToken()
  }, [deployed, refetchToken])

  const etherscan = JB_CHAINS[chainId]?.etherscanHostname
  const symbolOk = /^[A-Z0-9]{1,8}$/.test(symbol)
  const busy = sending || mining

  const deploy = async () => {
    if (busy || !symbolOk || !name.trim()) return
    setErrorMsg(null)
    setSending(true)
    try {
      await switchChainAsync({ chainId })
      const request = buildDeployTokenRequest({
        chainId,
        projectId: BigInt(projectId),
        name,
        symbol,
        controller,
      })
      const hash = await writeContractAsync(request)
      setTxHash(hash)
    } catch (e) {
      setErrorMsg(friendlyError(e))
    } finally {
      setSending(false)
    }
  }

  // The project already has its ERC-20 — show it instead of the deploy flow.
  if (token) {
    return (
      <Row
        title="Project token"
        byline={
          <>
            {tokenSymbol ? (
              <span className="mr-2 font-semibold text-lime">{tokenSymbol}</span>
            ) : null}
            {deployed
              ? 'Deployed — supporters can now claim their tokens.'
              : 'Your supporters’ tokens are a claimable ERC-20.'}
          </>
        }
        action={
          etherscan ? (
            <a
              href={`https://${etherscan}/token/${token}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-pixel min-h-[36px] shrink-0 px-4 text-[11px]"
            >
              {truncateAddress(token)}
            </a>
          ) : (
            <span className="text-xs text-dim">{truncateAddress(token)}</span>
          )
        }
      />
    )
  }

  return (
    <Row
      title="Project token"
      byline={
        tokenLoading
          ? 'Checking for your token…'
          : 'Supporters’ balances become a real ERC-20 they can claim & move.'
      }
      action={
        tokenLoading ? null : (
          <button
            onClick={() => setOpen(o => !o)}
            className="btn-pixel min-h-[36px] shrink-0 px-4 text-[11px]"
          >
            {open ? 'Close' : 'Create token'}
          </button>
        )
      }
    >
      {open && !tokenLoading ? (
        <div className="border-t-2 border-frame px-5 py-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_9rem]">
            <label className="block">
              <span className="silk-label">Token name</span>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value.slice(0, 100))}
                disabled={busy}
                className="input-well mt-1.5 min-h-[44px] px-4 text-sm font-semibold disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="silk-label">Symbol</span>
              <input
                type="text"
                value={symbol}
                onChange={e =>
                  setSymbol(
                    e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8),
                  )
                }
                disabled={busy}
                placeholder="JUICE"
                aria-label="Token symbol, 1 to 8 uppercase characters"
                className="input-well mt-1.5 min-h-[44px] px-4 font-pixel text-sm uppercase tracking-wider disabled:opacity-60"
              />
            </label>
          </div>

          <button
            onClick={deploy}
            disabled={busy || !symbolOk || !name.trim()}
            className="btn-juice mt-4 min-h-[48px] w-full text-sm"
          >
            {sending
              ? 'Confirm in your wallet…'
              : mining
                ? 'Deploying…'
                : symbol
                  ? `Deploy ${symbol}`
                  : 'Deploy token'}
          </button>

          <p className="mt-2.5 text-xs text-dim">
            One transaction. Existing balances carry over — nothing changes
            for supporters until they choose to claim.
          </p>

          {errorMsg ? <ErrorNote message={errorMsg} /> : null}
        </div>
      ) : null}
    </Row>
  )
}
