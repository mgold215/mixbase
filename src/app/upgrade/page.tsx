'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Nav from '@/components/Nav'
import { Check } from 'lucide-react'
import Link from 'next/link'

type SubscriptionData = {
  tier: string
  hasStripeSubscription: boolean
  price: string
}

type Plan = {
  id: 'free' | 'pro' | 'studio'
  name: string
  price: string
  period: string
  color: string
  features: string[]
}

const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    period: '/mo',
    color: '#888',
    features: [
      'Unlimited projects & versions',
      'A/B compare',
      'Public share links',
      'Release pipeline',
      'Feedback collection',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$8.99',
    period: '/mo',
    color: '#2dd4bf',
    features: [
      'Everything in Free',
      'AI artwork generation (25/mo)',
      'Flux 2 Pro + Imagen 4 models',
      'Artwork stamped with your branding',
    ],
  },
  {
    id: 'studio',
    name: 'Studio',
    price: '$19.99',
    period: '/mo',
    color: '#a78bfa',
    features: [
      'Everything in Pro',
      'Runway visualizer videos (10/mo)',
      'Gen-4 Turbo, Veo 3.1, Seedance 2.0',
      'Canvas-ready 9:16 exports',
    ],
  },
]

function UpgradeContent() {
  const searchParams = useSearchParams()
  const [sub, setSub] = useState<SubscriptionData | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/subscription')
      .then(r => r.json())
      .then(setSub)
      .catch(() => {})
  }, [])

  async function handleSubscribe(planId: 'pro' | 'studio') {
    setLoading(planId)
    setError('')
    try {
      const res = await fetch('/api/stripe/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planId }),
      })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        setError(data.error ?? 'Failed to start checkout')
      }
    } catch {
      setError('Network error. Try again.')
    }
    setLoading(null)
  }

  async function handleManage() {
    setLoading('manage')
    setError('')
    try {
      const res = await fetch('/api/stripe/portal', { method: 'POST' })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        setError(data.error ?? 'Failed to open billing portal')
      }
    } catch {
      setError('Network error. Try again.')
    }
    setLoading(null)
  }

  const currentTier = sub?.tier ?? 'free'
  const reason = searchParams.get('reason')

  function renderCTA(plan: Plan) {
    if (plan.id === 'free') {
      return (
        <div
          className="w-full py-3 rounded-xl text-sm font-medium text-center opacity-40"
          style={{ border: '1px solid var(--border)', color: 'var(--text-muted)' }}
        >
          Free forever
        </div>
      )
    }

    if (currentTier === plan.id) {
      return (
        <div
          className="w-full py-3 rounded-xl text-sm font-semibold text-center"
          style={{ backgroundColor: `${plan.color}20`, color: plan.color, border: `1px solid ${plan.color}40` }}
        >
          Current plan
        </div>
      )
    }

    if (sub?.hasStripeSubscription) {
      return (
        <button
          onClick={handleManage}
          disabled={loading === 'manage'}
          className="w-full py-3 rounded-xl text-sm font-semibold transition-opacity disabled:opacity-50"
          style={{ backgroundColor: plan.color, color: '#0a0a0a' }}
        >
          {loading === 'manage' ? 'Opening...' : 'Change plan'}
        </button>
      )
    }

    return (
      <button
        onClick={() => handleSubscribe(plan.id as 'pro' | 'studio')}
        disabled={!!loading}
        className="w-full py-3 rounded-xl text-sm font-semibold transition-opacity disabled:opacity-50"
        style={{ backgroundColor: plan.color, color: '#0a0a0a' }}
      >
        {loading === plan.id ? 'Redirecting...' : `Subscribe to ${plan.name}`}
      </button>
    )
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg-page)' }}>
      <Nav />
      <div className="max-w-4xl mx-auto px-5 pt-20 pb-16">
        <div className="text-center mb-10">
          <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--text)' }}>
            Upgrade mixBase
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Unlock AI-powered artwork and video generation for your releases.
          </p>
          {reason === 'artwork' && (
            <p className="text-xs mt-2 px-3 py-1.5 rounded-lg inline-block" style={{ backgroundColor: 'rgba(45,212,191,0.1)', color: '#2dd4bf' }}>
              Pro required for AI artwork generation
            </p>
          )}
          {reason === 'video' && (
            <p className="text-xs mt-2 px-3 py-1.5 rounded-lg inline-block" style={{ backgroundColor: 'rgba(167,139,250,0.1)', color: '#a78bfa' }}>
              Studio required for visualizer videos
            </p>
          )}
        </div>

        {error && (
          <p className="text-red-400 text-sm text-center mb-6">{error}</p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {PLANS.map(plan => (
            <div
              key={plan.id}
              className="rounded-2xl p-6 flex flex-col gap-5"
              style={{
                backgroundColor: 'var(--surface)',
                border: `1px solid ${currentTier === plan.id ? plan.color + '60' : 'var(--border)'}`,
              }}
            >
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: plan.color }}>
                    {plan.name}
                  </span>
                  {currentTier === plan.id && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ backgroundColor: `${plan.color}20`, color: plan.color }}>
                      Active
                    </span>
                  )}
                </div>
                <div className="flex items-end gap-0.5">
                  <span className="text-3xl font-bold" style={{ color: 'var(--text)' }}>{plan.price}</span>
                  <span className="text-sm mb-1" style={{ color: 'var(--text-muted)' }}>{plan.period}</span>
                </div>
              </div>

              <ul className="space-y-2 flex-1">
                {plan.features.map(f => (
                  <li key={f} className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    <Check size={14} className="mt-0.5 shrink-0" style={{ color: plan.color }} />
                    {f}
                  </li>
                ))}
              </ul>

              {renderCTA(plan)}
            </div>
          ))}
        </div>

        <p className="text-center text-xs mt-8" style={{ color: 'var(--text-muted)' }}>
          Cancel anytime. Managed by Stripe.{' '}
          <Link href="/profile" className="underline">Back to settings</Link>
        </p>
      </div>
    </div>
  )
}

export default function UpgradePage() {
  return (
    <Suspense fallback={null}>
      <UpgradeContent />
    </Suspense>
  )
}
