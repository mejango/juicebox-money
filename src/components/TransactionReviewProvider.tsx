'use client'

import {
  type PropsWithChildren,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  formatEther,
  toFunctionSelector,
  type AbiFunction,
  type AbiParameter,
  type Address,
} from 'viem'
import { useAccount } from 'wagmi'
import {
  buildTransactionReviewPrompt,
  registerTransactionReviewHandler,
  transactionReviewJson,
  type TransactionReviewCall,
  type TransactionReviewRequest,
} from '@/lib/transaction-review'
import { chainName } from '@/lib/urn'

type PendingReview = {
  id: number
  request: TransactionReviewRequest
  resolve: (approved: boolean) => void
}

function knownContractName(call: TransactionReviewCall): string | null {
  return call.contractName ?? null
}

function stringify(value: unknown): string {
  try {
    return (
      JSON.stringify(
        value,
        (_, item) => (typeof item === 'bigint' ? item.toString() : item),
        2,
      ) ?? String(value)
    )
  } catch {
    return String(value)
  }
}

function readableValue(type: string, value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    if (type === 'address') return value
    if (type.startsWith('bytes') && value.length > 50) {
      return `${value.slice(0, 22)}…${value.slice(-12)}`
    }
    return value
  }
  return stringify(value)
}

function namedValue(value: unknown, name: string, index: number): unknown {
  if (Array.isArray(value)) return value[index]
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return row[name] ?? row[index]
  }
  return undefined
}

function hasComponents(
  parameter: AbiParameter,
): parameter is AbiParameter & { components: readonly AbiParameter[] } {
  return 'components' in parameter && Array.isArray(parameter.components)
}

function ArgumentValue({
  parameter,
  value,
  depth = 0,
}: {
  parameter: AbiParameter
  value: unknown
  depth?: number
}) {
  const arrayMatch = parameter.type.match(/^(.*)\[(\d*)\]$/)
  if (arrayMatch && Array.isArray(value)) {
    const itemParameter = {
      ...parameter,
      type: arrayMatch[1],
    } as AbiParameter
    return (
      <div className="mt-2 space-y-2 border-l border-smoke-200 pl-3">
        {value.length ? (
          value.map((item, index) => (
            <div key={index}>
              <p className="font-mono text-[11px] font-medium text-smoke-600">
                [{index}]
              </p>
              <ArgumentValue
                parameter={itemParameter}
                value={item}
                depth={depth + 1}
              />
            </div>
          ))
        ) : (
          <span className="font-mono text-xs text-smoke-600">[]</span>
        )}
      </div>
    )
  }

  if (hasComponents(parameter)) {
    return (
      <div className="mt-2 space-y-2 border-l border-smoke-200 pl-3">
        {parameter.components.map((component, index) => (
          <ArgumentRow
            key={`${component.name || 'field'}-${index}`}
            parameter={component}
            value={namedValue(value, component.name ?? '', index)}
            depth={depth + 1}
          />
        ))}
      </div>
    )
  }

  return (
    <p className="break-all font-mono text-xs leading-relaxed text-ink">
      {readableValue(parameter.type, value)}
    </p>
  )
}

function ArgumentRow({
  parameter,
  value,
  depth = 0,
}: {
  parameter: AbiParameter
  value: unknown
  depth?: number
}) {
  return (
    <div className={depth ? '' : 'rounded-lg bg-grey-25 px-3 py-2.5'}>
      <p className="text-xs font-medium text-smoke-700">
        {parameter.name || 'argument'}{' '}
        <span className="font-mono font-normal text-smoke-500">
          {parameter.type}
        </span>
      </p>
      <ArgumentValue parameter={parameter} value={value} depth={depth} />
    </div>
  )
}

function functionFromCall(call: TransactionReviewCall): AbiFunction | null {
  if (!call.abi || !call.functionName) return null
  const selector = call.data.slice(0, 10)
  return (
    (call.abi.find(
      item =>
        item.type === 'function' &&
        item.name === call.functionName &&
        (selector.length !== 10 || toFunctionSelector(item) === selector),
    ) as AbiFunction | undefined) ?? null
  )
}

function nativeValue(value = 0n): string {
  return `${formatEther(value)} ETH · ${value.toString()} wei`
}

function PrettyCall({
  call,
  index,
  total,
}: {
  call: TransactionReviewCall
  index: number
  total: number
}) {
  const fn = functionFromCall(call)
  const args = call.args ?? []
  const byteLength = Math.max(0, (call.data.length - 2) / 2)
  const contractName = knownContractName(call)
  return (
    <section className="rounded-xl border border-smoke-200 bg-white p-4 sm:p-5">
      {total > 1 ? (
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-smoke-500">
          Transaction {index + 1} of {total}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="chip bg-bluebs-50 text-bluebs-700">
          {chainName(call.chainId)}
        </span>
        <span className="font-mono text-[11px] text-smoke-500">
          chain {call.chainId}
        </span>
      </div>

      {call.label ? (
        <h3 className="mt-3 font-agrandir text-base font-medium text-ink">
          {call.label}
        </h3>
      ) : null}

      <dl className="mt-4 space-y-3 text-sm">
        {call.from ? (
          <div>
            <dt className="text-xs font-medium text-smoke-600">From</dt>
            <dd className="mt-1 break-all font-mono text-xs text-ink">
              {call.from}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-xs font-medium text-smoke-600">
            Destination{contractName ? ` · ${contractName}` : ''}
          </dt>
          <dd className="mt-1 break-all font-mono text-xs text-ink">{call.to}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-smoke-600">Native value</dt>
          <dd className="mt-1 font-mono text-xs text-ink">
            {nativeValue(call.value)}
          </dd>
        </div>
      </dl>

      {fn ? (
        <div className="mt-5 border-t border-smoke-200 pt-4">
          <p className="text-xs font-medium text-smoke-600">Contract function</p>
          <p className="mt-1 break-all font-mono text-sm font-medium text-ink">
            {fn.name}(
            {fn.inputs.map(input => input.type).join(', ')})
          </p>
          {fn.inputs.length ? (
            <div className="mt-3 space-y-2">
              {fn.inputs.map((parameter, argumentIndex) => (
                <ArgumentRow
                  key={`${parameter.name || 'argument'}-${argumentIndex}`}
                  parameter={parameter}
                  value={args[argumentIndex]}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-5 rounded-lg bg-split-50 p-3 text-xs leading-relaxed text-split-800">
          <p className="font-medium">
            This call’s ABI is not available in this flow. Check the complete
            calldata in Raw before continuing.
          </p>
          <p className="mt-1 font-mono">
            {call.data === '0x' ? 'No calldata' : `Selector ${call.data.slice(0, 10)}`}
          </p>
        </div>
      )}

      <p className="mt-3 text-[11px] text-smoke-500">
        Calldata: {byteLength.toLocaleString()} byte{byteLength === 1 ? '' : 's'}
      </p>
    </section>
  )
}

function ReviewModal({
  pending,
  onFinish,
}: {
  pending: PendingReview
  onFinish: (approved: boolean) => void
}) {
  const { request } = pending
  const [agreed, setAgreed] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement as HTMLElement | null
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onFinish(false)
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      )
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [onFinish])

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildTransactionReviewPrompt(request))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    window.setTimeout(() => setCopyState('idle'), 2200)
  }

  const titleId = `transaction-review-title-${pending.id}`
  const descriptionId = `transaction-review-description-${pending.id}`
  const isAuthorization = request.kind === 'authorization'
  const defaultDescription = isAuthorization
    ? 'This authorization commits to the exact destination, native value, and calldata below. A Safe or relayer can submit that call onchain after you continue.'
    : 'This is the exact destination, native value, and calldata the app will ask your wallet to send. Your wallet adds the nonce, gas limit, and network fees.'

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-start justify-center overflow-y-auto bg-slate-950/60 px-3 py-4 backdrop-blur-[2px] sm:px-6 sm:py-8"
      onMouseDown={event => {
        if (event.currentTarget === event.target) onFinish(false)
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-smoke-300 bg-bone shadow-2xl sm:max-h-[calc(100vh-4rem)]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-smoke-200 bg-white px-4 py-4 sm:px-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-error-600">
              Client safety check
            </p>
            <h2
              id={titleId}
              className="mt-1 font-agrandir text-xl font-medium text-ink"
            >
              {request.title ??
                (isAuthorization ? 'Review authorization' : 'Review transaction')}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={() => onFinish(false)}
            aria-label="Cancel transaction review"
            className="icon-button -mr-2 -mt-2 shrink-0"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <div className="rounded-xl border border-error-200 bg-error-50 px-4 py-3">
            <p
              id={descriptionId}
              className="text-sm leading-relaxed text-error-800"
            >
              {request.description ?? defaultDescription}
            </p>
          </div>
          {request.authorization ? (
            <div className="mt-3 rounded-xl border border-bluebs-100 bg-bluebs-25 px-4 py-3 text-xs leading-relaxed text-bluebs-700">
              The Raw view also includes the exact typed-data domain and message
              your signature commits to.
            </div>
          ) : null}

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={copyPrompt}
              className="btn-link min-h-[36px] text-xs"
            >
              {copyState === 'copied'
                ? 'Prompt copied — paste into your LLM'
                : copyState === 'failed'
                  ? 'Could not copy prompt'
                  : '[copy tx audit prompt]'}
            </button>
          </div>

          <div className="mt-4 space-y-4">
            {request.calls.map((call, index) => (
              <PrettyCall
                key={`${call.chainId}-${call.to}-${index}`}
                call={call}
                index={index}
                total={request.calls.length}
              />
            ))}
          </div>

          <details className="mt-4 overflow-hidden rounded-xl border border-smoke-200 bg-white">
            <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-smoke-700 hover:bg-grey-25">
              Raw transaction payload
            </summary>
            <div className="border-t border-smoke-200 p-4">
              <p className="mb-2 text-xs leading-relaxed text-smoke-600">
                {request.authorization
                  ? 'Exact typed data plus the resulting app-controlled call. Hex value is the native token amount; data is the complete calldata.'
                  : 'Exact app-controlled JSON-RPC call fields. Hex value is the native token amount; data is the complete calldata.'}
              </p>
              <pre className="max-h-[28rem] overflow-auto rounded-xl border border-smoke-200 bg-grey-900 p-4 font-mono text-[11px] leading-relaxed text-grey-25">
                {transactionReviewJson(request)}
              </pre>
            </div>
          </details>
        </div>

        <footer className="shrink-0 border-t border-smoke-200 bg-white px-4 py-4 sm:px-6">
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-smoke-200 bg-grey-25 p-3 text-sm leading-relaxed text-ink">
            <input
              type="checkbox"
              checked={agreed}
              onChange={event => setAgreed(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span>
              I reviewed the chain, destination, native value, and calldata
              {request.authorization ? ', plus the exact typed data' : ''}. I
              agree to {isAuthorization ? 'authorize' : 'send'} this exact call.
            </span>
          </label>
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => onFinish(false)}
              className="btn-secondary min-h-[44px] px-5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onFinish(true)}
              disabled={!agreed}
              className="btn-primary min-h-[44px] px-5 text-sm"
            >
              {request.confirmLabel ??
                (isAuthorization ? 'Agree & authorize' : 'Agree & continue')}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

/**
 * Global, promise-based modal queue. Every low-level transaction boundary
 * registers with this one provider, so simultaneous multichain flows review
 * sequentially and each approval applies to one immutable call snapshot.
 */
export function TransactionReviewProvider({ children }: PropsWithChildren) {
  const { address } = useAccount()
  const accountRef = useRef<Address | undefined>(address)
  accountRef.current = address
  const nextId = useRef(1)
  const activeRef = useRef<PendingReview | null>(null)
  const queueRef = useRef<PendingReview[]>([])
  const [active, setActive] = useState<PendingReview | null>(null)

  const enqueue = useCallback(
    (request: TransactionReviewRequest) =>
      new Promise<boolean>(resolve => {
        const snapshot: TransactionReviewRequest = {
          ...request,
          calls: request.calls.map(call => ({
            ...call,
            from: call.from ?? accountRef.current,
            args: call.args ? [...call.args] : undefined,
          })),
        }
        const pending: PendingReview = {
          id: nextId.current++,
          request: snapshot,
          resolve,
        }
        if (activeRef.current) {
          queueRef.current.push(pending)
          return
        }
        activeRef.current = pending
        setActive(pending)
      }),
    [],
  )

  useEffect(() => registerTransactionReviewHandler(enqueue), [enqueue])

  useEffect(
    () => () => {
      activeRef.current?.resolve(false)
      queueRef.current.forEach(pending => pending.resolve(false))
      activeRef.current = null
      queueRef.current = []
    },
    [],
  )

  const finish = useCallback((approved: boolean) => {
    const current = activeRef.current
    if (!current) return
    const next = queueRef.current.shift() ?? null
    activeRef.current = next
    setActive(next)
    current.resolve(approved)
  }, [])

  return (
    <>
      {children}
      {active ? <ReviewModal key={active.id} pending={active} onFinish={finish} /> : null}
    </>
  )
}
