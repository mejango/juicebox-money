'use client'

import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import { getProjectCreationFee } from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BaseError, type PublicClient } from 'viem'
import { useConfig, useSwitchChain, useWriteContract } from 'wagmi'
import { getPublicClient, waitForTransactionReceipt } from 'wagmi/actions'
import { useWallet } from '@/hooks/useWallet'
import { formatTokenAmount, truncateAddress } from '@/lib/format'
import { buildLaunchRequest, projectIdFromReceipt } from '@/lib/launch'
import { chainChipClass } from '@/components/ChainBadge'
import { chainName, toUrn } from '@/lib/urn'
import { SUPPORTED_CHAINS } from '@/providers/Providers'

type SupportedChainId = (typeof SUPPORTED_CHAINS)[number]['id']

const MAX_LOGO_BYTES = 1024 * 1024

type ChainStatus = {
  phase: 'pending' | 'signing' | 'confirming' | 'done' | 'failed'
  txHash?: `0x${string}`
  projectId?: number
  error?: string
  indexed?: boolean
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

const STEP_TILES = [
  'bg-split-400 text-ink',
  'bg-bluebs-400 text-ink',
  'bg-melon-400 text-ink',
]

function StepBadge({ n }: { n: number }) {
  return (
    <span
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-agrandir text-sm font-medium ${
        STEP_TILES[(n - 1) % STEP_TILES.length]
      }`}
    >
      {n}
    </span>
  )
}

export function CreateForm() {
  const { isConnected, address, openSignIn } = useWallet()
  const config = useConfig()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()

  // Wallet state only exists client-side; render the signed-out shell on the
  // server so hydration always matches.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const connected = mounted && isConnected && !!address

  // --- Identity ---
  const [name, setName] = useState('')
  const [tagline, setTagline] = useState('')
  const [description, setDescription] = useState('')
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [logoError, setLogoError] = useState<string | null>(null)

  // --- Chains ---
  const [selected, setSelected] = useState<number[]>([SUPPORTED_CHAINS[0].id])

  // --- Launch state ---
  const [phase, setPhase] = useState<
    'form' | 'pinning' | 'launching' | 'failed' | 'done'
  >('form')
  const [statuses, setStatuses] = useState<Record<number, ChainStatus>>({})
  const statusesRef = useRef(statuses)
  statusesRef.current = statuses
  const [launchError, setLaunchError] = useState<string | null>(null)
  const projectUriRef = useRef<string | null>(null)

  // Once a launch run starts, the metadata is pinned — lock the inputs.
  const busy = phase !== 'form'

  useEffect(
    () => () => {
      if (logoPreview) URL.revokeObjectURL(logoPreview)
    },
    [logoPreview],
  )

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

  // Live creation fees, read per chain through the app's wagmi clients.
  const { data: fees } = useQuery({
    queryKey: ['creationFees'],
    staleTime: 60_000,
    queryFn: async () => {
      const results = await Promise.allSettled(
        SUPPORTED_CHAINS.map(chain =>
          getProjectCreationFee(
            getPublicClient(config, { chainId: chain.id }) as PublicClient,
            chain.id as JBChainId,
          ),
        ),
      )
      const byChain: Record<number, bigint | null> = {}
      SUPPORTED_CHAINS.forEach((chain, i) => {
        const r = results[i]
        byChain[chain.id] = r.status === 'fulfilled' ? r.value : null
      })
      return byChain
    },
  })

  const totalFee = useMemo(() => {
    if (!fees) return null
    let total = 0n
    for (const id of selected) {
      const fee = fees[id]
      if (fee === null || fee === undefined) return null
      total += fee
    }
    return total
  }, [fees, selected])

  const nameOk = name.trim().length > 0
  const canLaunch =
    nameOk && selected.length > 0 && (phase === 'form' || phase === 'failed')

  const toggleChain = (id: number) => {
    if (busy) return
    setSelected(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id].sort(),
    )
  }

  const updateStatus = (chainId: number, patch: Partial<ChainStatus>) => {
    setStatuses(prev => ({
      ...prev,
      [chainId]: { ...(prev[chainId] ?? { phase: 'pending' }), ...patch },
    }))
  }

  /** Pin logo (if any) then the metadata JSON. Returns the projectUri. */
  const pinMetadata = async (): Promise<string> => {
    let logoUri: string | undefined
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
      }),
    })
    const json = (await res.json()) as { cid?: string; error?: string }
    if (!res.ok || !json.cid) {
      throw new Error(json.error ?? 'Saving project details failed — try again.')
    }
    return `ipfs://${json.cid}`
  }

  /**
   * One wallet transaction per chain, sequentially. Skips chains already
   * done, so a retry resumes exactly where the run stopped.
   */
  const runChains = async (projectUri: string) => {
    setPhase('launching')
    for (const chainId of selected) {
      if (statusesRef.current[chainId]?.phase === 'done') continue
      updateStatus(chainId, { phase: 'signing', error: undefined })
      try {
        await switchChainAsync({ chainId: chainId as SupportedChainId })
        const client = getPublicClient(config, {
          chainId: chainId as SupportedChainId,
        }) as PublicClient
        // Fees are dynamic and must match msg.value EXACTLY — re-read right
        // before sending, never reuse across chains.
        const creationFee = await getProjectCreationFee(
          client,
          chainId as JBChainId,
        )
        const request = buildLaunchRequest({
          chainId: chainId as JBChainId,
          owner: address!,
          projectUri,
          creationFee,
        })
        const hash = await writeContractAsync(request)
        updateStatus(chainId, { phase: 'confirming', txHash: hash })
        const receipt = await waitForTransactionReceipt(config, {
          hash,
          chainId: chainId as SupportedChainId,
        })
        const projectId =
          receipt.status === 'success' ? projectIdFromReceipt(receipt) : null
        if (!projectId) throw new Error('Transaction failed on this chain.')
        updateStatus(chainId, { phase: 'done', projectId })
      } catch (e) {
        updateStatus(chainId, { phase: 'failed', error: friendlyError(e) })
        setPhase('failed')
        return // Stop here — retry resumes from this chain.
      }
    }
    if (selected.every(id => statusesRef.current[id]?.phase === 'done')) {
      setPhase('done')
    }
  }

  const launch = async () => {
    if (!connected) {
      openSignIn()
      return
    }
    if (!canLaunch) return
    setLaunchError(null)
    try {
      if (!projectUriRef.current) {
        setPhase('pinning')
        // Initialize the checklist before the first signature request.
        setStatuses(
          Object.fromEntries(selected.map(id => [id, { phase: 'pending' }])),
        )
        projectUriRef.current = await pinMetadata()
      }
      await runChains(projectUriRef.current)
    } catch (e) {
      setLaunchError(friendlyError(e))
      setPhase('form')
    }
  }

  const retry = () => {
    if (projectUriRef.current) void runChains(projectUriRef.current)
  }

  // Poll bendystraw for freshly launched projects until they're indexed.
  const doneUnindexed = Object.entries(statuses)
    .filter(([, s]) => s.phase === 'done' && s.projectId && !s.indexed)
    .map(([id]) => Number(id))
  useEffect(() => {
    if (doneUnindexed.length === 0) return
    const tick = async () => {
      for (const chainId of doneUnindexed) {
        const s = statusesRef.current[chainId]
        if (!s?.projectId || s.indexed) continue
        try {
          const res = await fetch(
            `/api/project-ready?chainId=${chainId}&projectId=${s.projectId}`,
          )
          const json = (await res.json()) as { found?: boolean }
          if (json.found) updateStatus(chainId, { indexed: true })
        } catch {
          // Transient — the next tick retries.
        }
      }
    }
    const t = setInterval(tick, 5000)
    void tick()
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneUnindexed.join(',')])

  // ---- Success view ----
  if (phase === 'done') {
    return (
      <div className="relative mx-auto max-w-2xl px-4 py-14 sm:px-6 sm:py-20">
        <div className="card p-8 text-center sm:p-10">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-melon-400">
            <svg
              viewBox="0 0 24 24"
              className="h-8 w-8 text-ink"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="m5 13 4 4L19 7" />
            </svg>
          </span>
          <h1 className="mt-5 font-agrandir text-3xl font-medium sm:text-4xl">
            {name.trim()} is live!
          </h1>
          <p className="mt-2 text-sm text-smoke-700">
            Your project page is being indexed — it usually takes about a
            minute to show up everywhere.
          </p>

          <ul className="mt-8 space-y-3 text-left">
            {selected.map(chainId => {
              const s = statuses[chainId]
              if (!s?.projectId) return null
              const urn = toUrn(chainId, s.projectId)
              return (
                <li
                  key={chainId}
                  className="flex items-center justify-between gap-3 rounded-xl border border-smoke-200 bg-bone px-4 py-3.5"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-ink">
                      Project #{s.projectId} on {chainName(chainId)}
                    </p>
                    <p className="text-xs text-smoke-700">
                      {s.indexed ? 'Indexed and ready' : 'Indexing…'}
                    </p>
                  </div>
                  {s.indexed ? (
                    <Link
                      href={`/${urn}`}
                      className="btn-primary min-h-[40px] shrink-0 px-5 text-xs"
                    >
                      View project
                    </Link>
                  ) : (
                    <span className="inline-flex min-h-[40px] shrink-0 items-center gap-2 rounded-full border border-smoke-300 px-5 text-sm text-smoke-700">
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-smoke-300 border-t-smoke-700" />
                      {urn}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    )
  }

  // ---- Form + progress checklist ----
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="font-agrandir-wide text-4xl font-bold leading-tight sm:text-5xl">
        Start a project<span className="text-split-500">.</span>
      </h1>
      <p className="mt-3 max-w-lg text-base leading-relaxed text-smoke-700 sm:text-lg">
        Give it a name, pick your chains, and launch. Live in minutes — you
        can change everything later.
      </p>

      {/* 1 — Identity */}
      <section className="card mt-10 p-6 sm:p-7">
        <div className="flex items-center gap-3">
          <StepBadge n={1} />
          <h2 className="font-agrandir text-xl font-medium">
            What are you making?
          </h2>
        </div>

        <label className="mt-5 block">
          <span className="field-label">
            Project name <span className="text-peel-500">*</span>
          </span>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value.slice(0, 100))}
            disabled={busy}
            placeholder="My juicy project"
            className="input-well mt-1.5 min-h-[52px] px-4 text-lg font-medium placeholder:font-normal disabled:opacity-60"
          />
        </label>

        <label className="mt-4 block">
          <span className="flex items-baseline justify-between">
            <span className="field-label">Tagline</span>
            <span className="text-xs text-smoke-500">{tagline.length}/100</span>
          </span>
          <input
            type="text"
            value={tagline}
            onChange={e => setTagline(e.target.value.slice(0, 100))}
            disabled={busy}
            placeholder="One line about your project (optional)"
            className="input-well mt-1.5 min-h-[48px] px-4 text-sm disabled:opacity-60"
          />
        </label>

        <label className="mt-4 block">
          <span className="field-label">Description</span>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value.slice(0, 5000))}
            disabled={busy}
            rows={4}
            placeholder="Tell supporters what you're building and why it matters (optional)"
            className="input-well mt-1.5 resize-y px-4 py-3 text-sm leading-relaxed disabled:opacity-60"
          />
        </label>

        <div className="mt-4">
          <span className="field-label">Logo</span>
          <div className="mt-1.5 flex items-center gap-4">
            {logoPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoPreview}
                alt="Logo preview"
                className="h-20 w-20 rounded-lg border border-smoke-200 object-cover"
              />
            ) : (
              <span className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-smoke-300 text-2xl">
                🧃
              </span>
            )}
            <div>
              <label className="btn-secondary min-h-[40px] cursor-pointer px-4 text-xs">
                {logoFile ? 'Change image' : 'Upload image'}
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
                  className="ml-3 text-xs font-medium text-smoke-700 underline underline-offset-2 hover:text-ink"
                >
                  Remove
                </button>
              ) : null}
              <p className="mt-1.5 text-xs text-smoke-700">
                Square works best. Up to 1MB — optional.
              </p>
              {logoError ? (
                <p className="mt-1 text-xs text-red-600">{logoError}</p>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {/* 2 — Chains */}
      <section className="card mt-5 p-6 sm:p-7">
        <div className="flex items-center gap-3">
          <StepBadge n={2} />
          <h2 className="font-agrandir text-xl font-medium">
            Where does it live?
          </h2>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-smoke-700">
          Your project gets the same address &amp; ID space on every chain you
          pick. You&apos;ll confirm one transaction per chain.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {SUPPORTED_CHAINS.map(chain => {
            const active = selected.includes(chain.id)
            return (
              <button
                key={chain.id}
                onClick={() => toggleChain(chain.id)}
                disabled={busy}
                aria-pressed={active}
                className={
                  active
                    ? `inline-flex min-h-[44px] items-center gap-2 rounded-full px-5 text-sm font-medium ring-1 ring-ink transition-colors disabled:opacity-60 ${chainChipClass(chain.id)}`
                    : 'inline-flex min-h-[44px] items-center gap-2 rounded-full border border-smoke-300 bg-white px-5 text-sm font-medium text-smoke-700 transition-colors hover:border-smoke-400 hover:text-ink disabled:opacity-60'
                }
              >
                {active ? (
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="m5 13 4 4L19 7" />
                  </svg>
                ) : null}
                {chainName(chain.id)}
              </button>
            )
          })}
        </div>
        {selected.length === 0 ? (
          <p className="mt-3 text-sm text-red-600">Pick at least one chain.</p>
        ) : null}
      </section>

      {/* 3 — Review & launch */}
      <section className="card mt-5 p-6 sm:p-7">
        <div className="flex items-center gap-3">
          <StepBadge n={3} />
          <h2 className="font-agrandir text-xl font-medium">
            Review &amp; launch
          </h2>
        </div>

        <dl className="mt-5 space-y-2.5 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-smoke-700">Owner</dt>
            <dd className="font-medium text-ink">
              {connected ? (
                <span>{truncateAddress(address!)}</span>
              ) : (
                <span className="text-smoke-700">Your connected wallet</span>
              )}
            </dd>
          </div>
          {selected.map(chainId => (
            <div
              key={chainId}
              className="flex items-center justify-between gap-3"
            >
              <dt className="text-smoke-700">
                Creation fee · {chainName(chainId)}
              </dt>
              <dd className="font-medium tabular-nums text-ink">
                {fees?.[chainId] !== undefined && fees?.[chainId] !== null
                  ? `${formatTokenAmount(fees[chainId]!, 18, 6)} ${
                      JB_CHAINS[chainId as JBChainId]?.nativeTokenSymbol ?? 'ETH'
                    }`
                  : '…'}
              </dd>
            </div>
          ))}
          {selected.length > 1 ? (
            <div className="flex items-center justify-between gap-3 border-t border-smoke-200 pt-2.5">
              <dt className="font-medium text-ink">Total</dt>
              <dd className="font-bold tabular-nums text-ink">
                {totalFee !== null
                  ? `${formatTokenAmount(totalFee, 18, 6)} ETH`
                  : '…'}
              </dd>
            </div>
          ) : null}
        </dl>

        <p className="mt-4 text-xs leading-relaxed text-smoke-700">
          Your project launches with friendly defaults: supporters get
          1,000,000 tokens per ETH, and you can change the rules any time.
        </p>

        <button
          onClick={launch}
          disabled={connected && !canLaunch}
          className="btn-primary mt-5 min-h-[56px] w-full text-base"
        >
          {phase === 'pinning'
            ? 'Saving your project details…'
            : phase === 'launching'
              ? 'Launching…'
              : phase === 'failed'
                ? 'Try again'
                : !connected
                  ? 'Sign in to launch'
                  : selected.length > 1
                    ? `Launch on ${selected.length} chains`
                    : 'Launch project'}
        </button>

        {launchError ? (
          <p className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            {launchError}
          </p>
        ) : null}

        {/* Per-chain progress checklist */}
        {phase === 'launching' ||
        Object.values(statuses).some(s => s.phase !== 'pending') ? (
          <ul className="mt-5 space-y-2" aria-live="polite">
            {selected.map(chainId => {
              const s = statuses[chainId] ?? { phase: 'pending' as const }
              const label =
                s.phase === 'pending'
                  ? 'Waiting'
                  : s.phase === 'signing'
                    ? 'Confirm in your wallet…'
                    : s.phase === 'confirming'
                      ? 'Confirming onchain…'
                      : s.phase === 'done'
                        ? `Launched — Project #${s.projectId}`
                        : (s.error ?? 'Failed')
              return (
                <li
                  key={chainId}
                  className="flex items-center gap-3 rounded-xl border border-smoke-200 bg-white px-4 py-3"
                >
                  {s.phase === 'done' ? (
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-melon-400">
                      <svg
                        viewBox="0 0 24 24"
                        className="h-3.5 w-3.5 text-ink"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="m5 13 4 4L19 7" />
                      </svg>
                    </span>
                  ) : s.phase === 'failed' ? (
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-red-500 text-xs font-bold text-red-600">
                      !
                    </span>
                  ) : s.phase === 'pending' ? (
                    <span className="h-6 w-6 shrink-0 rounded-full border-2 border-smoke-300" />
                  ) : (
                    <span className="h-6 w-6 shrink-0 animate-spin rounded-full border-2 border-smoke-200 border-t-split-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{chainName(chainId)}</p>
                    <p
                      className={`truncate text-xs ${s.phase === 'failed' ? 'text-red-600' : 'text-smoke-700'}`}
                    >
                      {label}
                    </p>
                  </div>
                  {s.phase === 'failed' && phase === 'failed' ? (
                    <button
                      onClick={retry}
                      className="btn-secondary shrink-0 px-4 py-1.5 text-xs"
                    >
                      Retry
                    </button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
      </section>
    </div>
  )
}
