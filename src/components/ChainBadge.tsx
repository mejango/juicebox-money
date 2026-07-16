import { chainName } from '@/lib/urn'

const DOTS: Record<number, string> = {
  1: 'bg-ink/70',
  10: 'bg-red-500',
  8453: 'bg-blue-600',
  42161: 'bg-sky-500',
  11155111: 'bg-ink/40',
  11155420: 'bg-red-300',
  84532: 'bg-blue-300',
  421614: 'bg-sky-300',
}

export function ChainBadge({ chainId }: { chainId: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 bg-white px-2.5 py-0.5 text-xs font-medium text-ink/70">
      <span
        className={`h-1.5 w-1.5 rounded-full ${DOTS[chainId] ?? 'bg-ink/40'}`}
      />
      {chainName(chainId)}
    </span>
  )
}
