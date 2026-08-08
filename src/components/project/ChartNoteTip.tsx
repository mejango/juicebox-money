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
export function ChartNoteTip({
  note,
  kind = 'info',
}: {
  note: string
  /** `info` qualifies data that is already shown; `help` defines a term the reader may not
   *  know. Two icons because they answer different questions — collapsing them into one
   *  teaches people that the icon means nothing in particular. */
  kind?: 'info' | 'help'
}) {
  return (
    <span
      role="note"
      aria-label={note}
      title={note}
      tabIndex={0}
      className="flex shrink-0 cursor-help items-center justify-center text-smoke-400 transition-colors hover:text-ink focus:text-ink focus:outline-none"
    >
      {/* Heroicons outline, `currentColor` so they inherit the hover and focus colours above
          rather than pinning the source's #1A1A1A. */}
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
        <path
          d={
            kind === 'help'
              ? 'M9.87891 7.51884C11.0505 6.49372 12.95 6.49372 14.1215 7.51884C15.2931 8.54397 15.2931 10.206 14.1215 11.2312C13.9176 11.4096 13.6917 11.5569 13.4513 11.6733C12.7056 12.0341 12.0002 12.6716 12.0002 13.5V14.25M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12ZM12 17.25H12.0075V17.2575H12V17.25Z'
              : 'M11.25 11.25L11.2915 11.2293C11.8646 10.9427 12.5099 11.4603 12.3545 12.082L11.6455 14.918C11.4901 15.5397 12.1354 16.0573 12.7085 15.7707L12.75 15.75M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12ZM12 8.25H12.0075V8.2575H12V8.25Z'
          }
        />
      </svg>
    </span>
  )
}
