import { redirect } from 'next/navigation'

// Root just redirects to the dashboard
export default function Home() {
  redirect('/dashboard')
}
