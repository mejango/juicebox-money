import Image from 'next/image'
import Link from 'next/link'
import emptyIllustration from '@/assets/illustrations/empty.png'

export default function NotFound() {
  return (
    <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-20 sm:px-6 sm:py-24 md:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col items-start">
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
      <Image
        src={emptyIllustration}
        alt=""
        sizes="(min-width: 768px) 320px, 260px"
        className="mx-auto h-auto w-full max-w-[260px] md:max-w-none"
        aria-hidden
      />
    </div>
  )
}
