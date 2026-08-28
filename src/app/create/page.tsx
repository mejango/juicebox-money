import type { Metadata } from 'next'
import { pageMetadata } from '@/lib/page-metadata'
import { CreateForm } from '@/components/create/CreateForm'

const title = 'Start a project'
const description =
  'Launch a Juicebox project in minutes: name it, pick your chains, and go live with a transparent onchain treasury.'

export const metadata: Metadata = pageMetadata({ title, description })

export default function CreatePage() {
  return <CreateForm />
}
