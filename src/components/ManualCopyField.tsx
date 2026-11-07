export const COPY_BLOCKED_MESSAGE =
  'Copy was blocked by your browser. Select and copy the prompt below.'

/** The prompt as selectable text, for when the clipboard refuses. */
export function ManualCopyField({
  id,
  label,
  value,
}: {
  id: string
  label: string
  value: string
}) {
  return (
    <>
      <label htmlFor={id} className="mb-2 block font-medium">
        {label}
      </label>
      <textarea
        id={id}
        readOnly
        value={value}
        rows={10}
        spellCheck={false}
        className="block w-full rounded-lg border border-smoke-300 bg-white p-3 text-sm leading-relaxed text-ink"
      />
    </>
  )
}
