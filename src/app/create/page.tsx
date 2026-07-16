import type { Metadata } from 'next'
import { CreateForm } from '@/components/create/CreateForm'

export const metadata: Metadata = {
  title: 'Start a project',
  description:
    'Launch a Juicebox project in minutes: name it, pick your chains, and go live with a transparent onchain treasury.',
}

export default function CreatePage() {
  return <CreateForm />
}
