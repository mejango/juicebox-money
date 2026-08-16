import { HoverNote } from '@/components/project/HoverNote'

/**
 * A small (!) carrying a chart caveat without spending a line of layout.
 *
 * Qualifies DATA that is shown — an approximation, a sampling caveat, a stale read. Defining a
 * TERM is `ConceptTerm`'s job, which underlines the word instead of adding a glyph beside it.
 *
 * For notes that are ALWAYS true of a given project rather than notes about something being
 * wrong — a permanent banner reads as a warning and trains the reader to ignore it. Anything
 * saying data is missing or a source is down belongs inline, where it cannot be missed.
 *
 * `HoverNote` rather than a native `title`: the browser holds its own tooltip back for about a
 * second, which reads as the hover doing nothing. `aria-label` still carries the text.
 */
export function ChartNoteTip({ note }: { note: string }) {
  return (
    <HoverNote
      note={note}
      role="note"
      aria-label={note}
      className="flex shrink-0 items-center justify-center text-smoke-400 transition-colors hover:text-ink focus:text-ink focus:outline-none"
    >
      {/* Heroicons outline information-circle, `currentColor` so it inherits the hover and
          focus colours above rather than pinning the source's #1A1A1A. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-[18px] w-[18px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M11.25 11.25L11.2915 11.2293C11.8646 10.9427 12.5099 11.4603 12.3545 12.082L11.6455 14.918C11.4901 15.5397 12.1354 16.0573 12.7085 15.7707L12.75 15.75M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12ZM12 8.25H12.0075V8.2575H12V8.25Z" />
      </svg>
    </HoverNote>
  )
}
