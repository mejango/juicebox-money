'use client'

import dynamic from 'next/dynamic'

/**
 * The project page's fallback view (no indexed project) renders the handle
 * card; its ENS, Safe and review code loads with the card, not the page. A
 * server page's own dynamic() still lands in its chunks, so this client module
 * owns the split. The server render keeps the card's HTML until it hydrates.
 */
export const ProjectHandleCard = dynamic(() =>
  import('./ProjectHandleCard').then(module => module.ProjectHandleCard),
)
