import type { Metadata } from 'next'
import { CreateForm } from '@/components/create/CreateForm'

const title = 'Start a project'
const description =
  'Launch a Juicebox project in minutes: name it, pick your chains, and go live with a transparent onchain treasury.'

export const metadata: Metadata = {
  title,
  description,
  // Without its own card this page inherited the site-wide one, so every link to it
  // unfurled as the generic homepage.
  openGraph: { title: `${title} — Juicebox`, description },
  twitter: { title: `${title} — Juicebox`, description },
}

export default function CreatePage() {
  return <CreateForm />
}
