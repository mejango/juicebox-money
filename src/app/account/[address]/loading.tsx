import {
  ActivityRailSkeleton,
  ProjectCardSkeleton,
} from '@/components/LoadingSkeletons'
import { Skeleton } from '@/components/ui/Skeleton'

export default function Loading() {
  return (
    <div
      className="mx-auto max-w-6xl px-6 py-8 sm:py-12"
      role="status"
      aria-label="Loading account"
    >
      <span className="sr-only">Loading account</span>
      <header className="flex items-center gap-4">
        <Skeleton className="h-16 w-16 shrink-0 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-48 rounded" />
          <Skeleton className="h-3 w-28 rounded" />
        </div>
      </header>
      <Skeleton className="mb-3 mt-10 h-6 w-24 rounded" />
      <ActivityRailSkeleton rows={5} />
      <Skeleton className="mb-3 mt-10 h-6 w-36 rounded" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <ProjectCardSkeleton key={index} index={index} />
        ))}
      </div>
    </div>
  )
}
