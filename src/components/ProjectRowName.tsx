/** Names that occur more than once in a ranked list. */
export function repeatedNames(rows: readonly { name: string }[]): Set<string> {
  const names = rows.map(row => row.name)
  return new Set(names.filter((name, index) => names.indexOf(name) !== index))
}

/** A ranked row's name, told apart by project ID when the list repeats it. */
export function ProjectRowName({
  name,
  projectId,
  repeated,
}: {
  name: string
  projectId: number
  repeated: boolean
}) {
  return (
    <span
      title={name}
      className="flex items-baseline gap-1.5 text-sm font-medium group-hover:text-bluebs-600"
    >
      <span className="truncate">{name}</span>
      {repeated ? (
        <span className="shrink-0 text-xs font-normal tabular-nums text-smoke-500">
          #{projectId}
        </span>
      ) : null}
    </span>
  )
}
