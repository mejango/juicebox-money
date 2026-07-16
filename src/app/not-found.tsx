import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col items-start px-4 py-24 sm:px-6">
      <p className="text-6xl" aria-hidden>
        🧃
      </p>
      <h1 className="mt-6 text-3xl font-extrabold tracking-tight sm:text-4xl">
        This juicebox is empty.
      </h1>
      <p className="mt-3 max-w-md text-lg text-ink/60">
        We couldn&apos;t find that page. It may have moved, or the project
        address might be misspelled.
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex min-h-[48px] items-center rounded-full bg-juice-500 px-7 text-base font-bold text-ink transition-colors hover:bg-juice-600"
      >
        Back to home
      </Link>
    </div>
  )
}
