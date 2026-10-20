'use client'

import dynamic from 'next/dynamic'

/**
 * The project page's fallback view (no indexed project) renders the handle
 * card; its ENS, Safe and review code loads with the card, not the page. A
 * server page's own dynamic() still lands in its chunks, so this client module
 * owns the split. The server render keeps the card's HTML until it hydrates;
 * the loading line is its own boundary, so a first open in a tab never falls
 * through to the route skeleton.
 */
export const ProjectHandleCard = dynamic(
  () => import('./ProjectHandleCard').then(module => module.ProjectHandleCard),
  { loading: () => <p role="status" className="text-sm text-smoke-600">Loading handle…</p> },
)
