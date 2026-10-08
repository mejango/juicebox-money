'use client'

import {
  skipToken,
  useQuery,
  type DefaultError,
  type QueryKey,
  type QueryObserverResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'

const subscribe = () => () => {}
const clientSnapshot = () => true
const serverSnapshot = () => false

/** The same per-component hydration boundary used by Revnet and Sticky. */
function useHydrated() {
  return useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot)
}

/** Match an unseeded server read, including its loading flags, until this component hydrates. */
function asOnServer<TResult extends QueryObserverResult<unknown, unknown>>(result: TResult, fetching: boolean): TResult {
  return {
    data: undefined,
    dataUpdatedAt: 0,
    error: null,
    errorUpdatedAt: 0,
    errorUpdateCount: 0,
    failureCount: 0,
    failureReason: null,
    status: 'pending',
    fetchStatus: fetching ? 'fetching' : 'idle',
    isPending: true,
    isSuccess: false,
    isError: false,
    isLoadingError: false,
    isRefetchError: false,
    isFetching: fetching,
    isLoading: fetching,
    isInitialLoading: fetching,
    isRefetching: false,
    isPaused: false,
    isPlaceholderData: false,
    isFetched: false,
    isFetchedAfterMount: false,
    isStale: true,
    isEnabled: fetching,
    refetch: result.refetch,
  } as unknown as TResult
}

/**
 * Sticky's persisted-read pattern: a cache restored at window.load must not change a later component's
 * first hydration render. Subsequent client mounts see the cache immediately. These persisted reads
 * have no server seed; a seeded read must preserve its own server value instead of using this adapter.
 */
export function useKeptQuery<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>): UseQueryResult<TData, TError> {
  const hydrated = useHydrated()
  const result = useQuery(options)
  return hydrated ? result : asOnServer(result, options.enabled !== false && options.queryFn !== skipToken)
}
