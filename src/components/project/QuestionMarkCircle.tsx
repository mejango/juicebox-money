/**
 * Heroicons outline `question-mark-circle`, inlined with `currentColor` per this app's SVG
 * convention (the source pins #1A1A1A).
 *
 * Marks an explanation of a CONCEPT — what a term means — as distinct from the information
 * circle on `ChartNoteTip`, which qualifies data that is already shown. Purely decorative: the
 * element it sits in carries the text, so this stays aria-hidden rather than announcing twice.
 */
export function QuestionMarkCircle({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.87891 7.51884C11.0505 6.49372 12.95 6.49372 14.1215 7.51884C15.2931 8.54397 15.2931 10.206 14.1215 11.2312C13.9176 11.4096 13.6917 11.5569 13.4513 11.6733C12.7056 12.0341 12.0002 12.6716 12.0002 13.5V14.25M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12ZM12 17.25H12.0075V17.2575H12V17.25Z" />
    </svg>
  )
}
