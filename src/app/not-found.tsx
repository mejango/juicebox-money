import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col items-start px-4 py-24 sm:px-6">
      <span className="chip bg-crush-100 text-crush-700">404 · Not found</span>
      <h1 className="mt-6 font-agrandir-wide text-4xl font-bold sm:text-5xl">
        This juicebox is empty<span className="text-split-500">.</span>
      </h1>
      <p className="mt-4 max-w-md text-base leading-relaxed text-smoke-700">
        We couldn&apos;t find that page. It may have moved, or the project
        address might be misspelled.
      </p>
      <Link href="/" className="btn-primary mt-8 min-h-[48px] px-7 text-sm">
        Back to home
      </Link>
    </div>
  )
}
