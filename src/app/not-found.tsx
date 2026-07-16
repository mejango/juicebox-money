import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col items-start px-4 py-24 sm:px-6">
      <span aria-hidden className="pixel-blip" />
      <p className="mt-6 font-pixel text-sm uppercase tracking-widest text-dim">
        404 · Not found
      </p>
      <h1 className="mt-4 font-display text-4xl font-extrabold tracking-[-0.03em] sm:text-5xl">
        This juicebox is empty<span className="text-juice">.</span>
      </h1>
      <p className="mt-4 max-w-md text-base leading-relaxed text-dim">
        We couldn&apos;t find that page. It may have moved, or the project
        address might be misspelled.
      </p>
      <Link href="/" className="btn-juice mt-8 min-h-[48px] px-7 text-sm">
        Back to home
      </Link>
    </div>
  )
}
