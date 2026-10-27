'use server'

import { revalidatePath } from 'next/cache'

/** Retry public homepage reads, including a cached unavailable panel. */
export async function refreshHomepageReserves(): Promise<void> {
  revalidatePath('/')
}
