'use client'

// The 404 page's own next/image reference. The 404 page shares the root
// layout's client manifest with the home page, which renders next/image too, so
// a direct reference would load the home page's chunks with every 404.
export { default as NotFoundImage } from 'next/image'
