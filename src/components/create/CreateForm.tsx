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

function StepBadge({ n }: { n: number }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-juice-400 text-sm font-extrabold text-ink">
      {n}
    </span>
  )
}

/** A one-shot, CSS-only confetti burst — tasteful, plays once. */
function Confetti() {
  const colors = ['#F5A312', '#FFB32C', '#34d399', '#60a5fa', '#f87171']
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0">
      {Array.from({ length: 18 }).map((_, i) => (
        <span
          key={i}
          className="confetti-piece"
          style={{
            left: `${4 + ((i * 37) % 92)}%`,
            backgroundColor: colors[i % colors.length],
            animationDelay: `${(i % 6) * 90}ms`,
            animationDuration: `${1100 + ((i * 97) % 700)}ms`,
          }}
        />
      ))}
    </div>
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
        <Confetti />
        <div className="rounded-3xl border border-ink/10 bg-white p-8 text-center shadow-sm sm:p-10">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
            <svg
              viewBox="0 0 24 24"
              className="h-8 w-8 text-emerald-600"
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
          <h1 className="mt-5 text-3xl font-extrabold tracking-tight sm:text-4xl">
            {name.trim()} is live!
          </h1>
          <p className="mt-2 text-ink/60">
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
                  className="flex items-center justify-between gap-3 rounded-2xl border border-ink/10 bg-cream/60 px-4 py-3.5"
                >
                  <div className="min-w-0">
                    <p className="font-bold">
                      Project #{s.projectId} on {chainName(chainId)}
                    </p>
                    <p className="text-xs text-ink/50">
                      {s.indexed ? 'Indexed and ready' : 'Indexing…'}
                    </p>
                  </div>
                  {s.indexed ? (
                    <Link
                      href={`/${urn}`}
                      className="inline-flex min-h-[40px] shrink-0 items-center rounded-full bg-juice-500 px-5 text-sm font-bold text-ink transition-colors hover:bg-juice-600"
                    >
                      View project
                    </Link>
                  ) : (
                    <span className="inline-flex min-h-[40px] shrink-0 items-center gap-2 rounded-full border border-ink/15 px-5 text-sm font-semibold text-ink/40">
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink/20 border-t-ink/60" />
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
      <h1 className="text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
        Start <span className="juice-underline">a project</span>.
      </h1>
      <p className="mt-3 max-w-lg text-lg text-ink/60">
        Give it a name, pick your chains, and launch. Live in minutes — you
        can change everything later.
      </p>

      {/* 1 — Identity */}
      <section className="mt-10 rounded-3xl border border-ink/10 bg-white p-6 shadow-sm sm:p-7">
        <div className="flex items-center gap-3">
          <StepBadge n={1} />
          <h2 className="text-xl font-extrabold tracking-tight">
            What are you making?
          </h2>
        </div>

        <label className="mt-5 block">
          <span className="text-sm font-medium text-ink/60">
            Project name <span className="text-juice-600">*</span>
          </span>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value.slice(0, 100))}
            disabled={busy}
            placeholder="My juicy project"
            className="mt-1.5 min-h-[52px] w-full rounded-2xl border border-ink/15 bg-cream/60 px-4 text-lg font-semibold outline-none transition-colors placeholder:font-normal placeholder:text-ink/30 focus:border-juice-500 focus:ring-2 focus:ring-juice-400/30 disabled:opacity-60"
          />
        </label>

        <label className="mt-4 block">
          <span className="flex items-baseline justify-between text-sm font-medium text-ink/60">
            Tagline{' '}
            <span className="text-xs text-ink/40">{tagline.length}/100</span>
          </span>
          <input
            type="text"
            value={tagline}
            onChange={e => setTagline(e.target.value.slice(0, 100))}
            disabled={busy}
            placeholder="One line about your project (optional)"
            className="mt-1.5 min-h-[48px] w-full rounded-2xl border border-ink/15 bg-cream/60 px-4 text-sm outline-none transition-colors placeholder:text-ink/30 focus:border-juice-500 focus:ring-2 focus:ring-juice-400/30 disabled:opacity-60"
          />
        </label>

        <label className="mt-4 block">
          <span className="text-sm font-medium text-ink/60">Description</span>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value.slice(0, 5000))}
            disabled={busy}
            rows={4}
            placeholder="Tell supporters what you're building and why it matters (optional)"
            className="mt-1.5 w-full resize-y rounded-2xl border border-ink/15 bg-cream/60 px-4 py-3 text-sm leading-relaxed outline-none transition-colors placeholder:text-ink/30 focus:border-juice-500 focus:ring-2 focus:ring-juice-400/30 disabled:opacity-60"
          />
        </label>

        <div className="mt-4">
          <span className="text-sm font-medium text-ink/60">Logo</span>
          <div className="mt-1.5 flex items-center gap-4">
            {logoPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoPreview}
                alt="Logo preview"
                className="h-20 w-20 rounded-2xl border border-ink/10 object-cover"
              />
            ) : (
              <span className="flex h-20 w-20 items-center justify-center rounded-2xl border-2 border-dashed border-ink/15 text-2xl text-ink/25">
                🧃
              </span>
            )}
            <div>
              <label className="inline-flex min-h-[40px] cursor-pointer items-center rounded-full border border-ink/15 bg-white px-4 text-sm font-semibold transition-colors hover:border-juice-500">
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
                  className="ml-3 text-sm font-medium text-ink/50 hover:text-ink"
                >
                  Remove
                </button>
              ) : null}
              <p className="mt-1.5 text-xs text-ink/40">
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
      <section className="mt-5 rounded-3xl border border-ink/10 bg-white p-6 shadow-sm sm:p-7">
        <div className="flex items-center gap-3">
          <StepBadge n={2} />
          <h2 className="text-xl font-extrabold tracking-tight">
            Where does it live?
          </h2>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-ink/60">
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
                    ? 'inline-flex min-h-[44px] items-center gap-2 rounded-full bg-ink px-5 text-sm font-semibold text-white transition-colors disabled:opacity-60'
                    : 'inline-flex min-h-[44px] items-center gap-2 rounded-full border border-ink/15 bg-white px-5 text-sm font-medium text-ink/70 transition-colors hover:border-juice-500 hover:text-ink disabled:opacity-60'
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
      <section className="mt-5 rounded-3xl border border-ink/10 bg-white p-6 shadow-sm sm:p-7">
        <div className="flex items-center gap-3">
          <StepBadge n={3} />
          <h2 className="text-xl font-extrabold tracking-tight">
            Review &amp; launch
          </h2>
        </div>

        <dl className="mt-5 space-y-2.5 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-ink/50">Owner</dt>
            <dd className="font-semibold">
              {connected ? (
                <span className="font-mono">{truncateAddress(address!)}</span>
              ) : (
                <span className="text-ink/40">Your connected wallet</span>
              )}
            </dd>
          </div>
          {selected.map(chainId => (
            <div
              key={chainId}
              className="flex items-center justify-between gap-3"
            >
              <dt className="text-ink/50">
                Creation fee · {chainName(chainId)}
              </dt>
              <dd className="font-semibold tabular-nums">
                {fees?.[chainId] !== undefined && fees?.[chainId] !== null
                  ? `${formatTokenAmount(fees[chainId]!, 18, 6)} ${
                      JB_CHAINS[chainId as JBChainId]?.nativeTokenSymbol ?? 'ETH'
                    }`
                  : '…'}
              </dd>
            </div>
          ))}
          {selected.length > 1 ? (
            <div className="flex items-center justify-between gap-3 border-t border-ink/10 pt-2.5">
              <dt className="font-semibold text-ink/70">Total</dt>
              <dd className="font-extrabold tabular-nums">
                {totalFee !== null
                  ? `${formatTokenAmount(totalFee, 18, 6)} ETH`
                  : '…'}
              </dd>
            </div>
          ) : null}
        </dl>

        <p className="mt-4 text-xs leading-relaxed text-ink/40">
          Your project launches with friendly defaults: supporters get
          1,000,000 tokens per ETH, and you can change the rules any time.
        </p>

        <button
          onClick={launch}
          disabled={connected && !canLaunch}
          className="mt-5 min-h-[56px] w-full rounded-2xl bg-juice-500 text-lg font-bold text-ink transition-colors hover:bg-juice-600 disabled:cursor-not-allowed disabled:opacity-50"
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
          <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
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
                  className="flex items-center gap-3 rounded-2xl border border-ink/10 bg-cream/60 px-4 py-3"
                >
                  {s.phase === 'done' ? (
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-100">
                      <svg
                        viewBox="0 0 24 24"
                        className="h-3.5 w-3.5 text-emerald-600"
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
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-100 text-xs font-bold text-red-600">
                      !
                    </span>
                  ) : s.phase === 'pending' ? (
                    <span className="h-6 w-6 shrink-0 rounded-full border-2 border-ink/10" />
                  ) : (
                    <span className="h-6 w-6 shrink-0 animate-spin rounded-full border-2 border-ink/15 border-t-juice-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold">{chainName(chainId)}</p>
                    <p
                      className={`truncate text-xs ${s.phase === 'failed' ? 'text-red-600' : 'text-ink/50'}`}
                    >
                      {label}
                    </p>
                  </div>
                  {s.phase === 'failed' && phase === 'failed' ? (
                    <button
                      onClick={retry}
                      className="shrink-0 rounded-full border border-ink/15 bg-white px-4 py-1.5 text-sm font-semibold transition-colors hover:border-juice-500"
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
