import { HoverNote } from '@/components/project/HoverNote'

/**
 * A term whose definition appears on hover, marked by a dotted underline.
 *
 * The underline rather than an icon, for anything rendered AS TEXT: it attaches to the exact
 * word being defined instead of floating beside it, it is the `<abbr>`/`<dfn>` convention
 * readers already know, and it adds no visual mass — which is what breaks down when several
 * defined terms sit in a row and each grows a competing glyph.
 *
 * An icon is only right where there is no text to underline. There is no such case in this
 * app today; if one appears, add `QuestionMarkCircle` back rather than switching this.
 *
 * Distinct from `ChartNoteTip` (ⓘ), which qualifies data that is shown rather than defining a
 * term.
 */
export function ConceptTerm({
  note,
  children,
  className = '',
}: {
  note: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <HoverNote
      note={note}
      className={`border-b border-dotted border-smoke-400 transition-colors hover:border-smoke-600 focus:border-smoke-600 focus:outline-none ${className}`}
    >
      {children}
    </HoverNote>
  )
}
