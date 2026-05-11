import { cn } from './utils';

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('animate-pulse bg-bg-hover rounded-sm', className)}
      aria-busy="true"
      aria-hidden="true"
    />
  );
}

export function AgentCardSkeleton() {
  return (
    <div className="rounded-md border border-border bg-bg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-12" />
      </div>
      <Skeleton className="h-4 w-40" />
      <div className="grid grid-cols-2 gap-2 pt-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
      </div>
      <div className="flex gap-1 pt-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-16" />
      </div>
    </div>
  );
}

export function TaskCardSkeleton() {
  return (
    <div className="rounded-md border border-border bg-bg p-3 space-y-2">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-5 w-3/4" />
      <div className="flex gap-3 pt-2">
        <Skeleton className="h-14 w-14 rounded-full" />
        <div className="flex-1 space-y-1">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      </div>
    </div>
  );
}
