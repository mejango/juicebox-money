/**
 * A small (!) carrying a chart caveat without spending a line of layout.
 *
 * For notes that are ALWAYS true of a given project rather than notes about something being
 * wrong — a permanent banner reads as a warning and trains the reader to ignore it. Anything
 * saying data is missing or a source is down belongs inline, where it cannot be missed.
 *
 * Native `title` rather than a JS tooltip: it is the app's existing convention, it works on
 * keyboard focus, and it degrades to a long-press on touch where there is no hover at all.
 */
export function ChartNoteTip({ note }: { note: string }) {
  return (
    <span
      role="note"
      aria-label={note}
      title={note}
      tabIndex={0}
      className="flex h-5 w-5 shrink-0 cursor-help items-center justify-center rounded-full border border-smoke-300 text-[11px] font-semibold leading-none text-smoke-500 transition-colors hover:border-smoke-400 hover:text-ink focus:border-smoke-400 focus:text-ink focus:outline-none"
    >
      !
    </span>
  )
}
