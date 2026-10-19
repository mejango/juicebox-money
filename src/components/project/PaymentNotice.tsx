/** Project-authored payment terms, kept intact behind a compact native disclosure. */
export function PaymentNotice({ text }: { text?: string }) {
  if (!text?.trim()) return null

  return (
    <details className="group rounded-xl border border-smoke-200 bg-white text-sm text-smoke-700">
      <summary className="cursor-pointer list-none rounded-xl p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bluebs-500 [&::-webkit-details-marker]:hidden">
        <span className="block font-medium text-ink">Payment notice</span>
        <span className="mt-2 line-clamp-3 whitespace-pre-line break-words text-xs leading-relaxed group-open:hidden">
          {text}
        </span>
        <span className="mt-2 block text-xs font-medium text-bluebs-700 underline underline-offset-2">
          <span className="group-open:hidden">Show full notice</span>
          <span className="hidden group-open:inline">Show less</span>
        </span>
      </summary>
      <p className="whitespace-pre-wrap break-words px-4 pb-4 text-xs leading-relaxed [overflow-wrap:anywhere]">
        {text}
      </p>
    </details>
  )
}
