// Declarative source of truth for the mixBase infrastructure diagram.
//
// This file describes the *shape* of the architecture — the nodes (services,
// databases, external APIs) and the edges (data-flow between them). It contains
// NO live calls and NO secrets; it is safe to serialize wholesale to the macOS
// infra client. Live status badges are merged onto these nodes at request time
// by `src/app/api/infra/topology/route.ts` using the railway/supabase aggregators.
//
// To evolve the diagram, edit this file only — every consumer reads from here.

export type ProviderId =
  | 'web'
  | 'apple'
  | 'namecheap'
  | 'railway'
  | 'supabase'
  | 'anthropic'
  | 'replicate'
  | 'runway'
  | 'stripe'
  | 'sentry'
  | 'github'

export type NodeType =
  | 'client'
  | 'dns'
  | 'compute'
  | 'database'
  | 'storage'
  | 'auth'
  | 'external'
  | 'ci'
  | 'monitor'

// Columns of the curated layered layout (left → right in the macOS canvas).
export type InfraLayer = 'client' | 'edge' | 'app' | 'data' | 'external'

// Which live aggregator (if any) populates this node's status badge.
// 'static' nodes are drawn but not probed in phase 1.
export type StatusSource = 'railway' | 'supabase' | 'health' | 'static'

export interface InfraNode {
  id: string
  type: NodeType
  provider: ProviderId
  label: string
  layer: InfraLayer
  statusSource: StatusSource
  description?: string
}

export interface InfraEdge {
  from: string
  to: string
  label?: string
  kind?: 'http' | 'sql' | 'storage' | 'auth' | 'deploy' | 'webhook'
}

export const INFRA_NODES: InfraNode[] = [
  // ── Client layer ─────────────────────────────────────────────────────────
  { id: 'web',   type: 'client', provider: 'web',   label: 'Web / PWA',          layer: 'client', statusSource: 'static', description: 'Browser & installed PWA at mixbase.app' },
  { id: 'ios',   type: 'client', provider: 'apple', label: 'iOS App',            layer: 'client', statusSource: 'static', description: 'Native SwiftUI app (ios/mixBase.xcodeproj)' },
  { id: 'macos', type: 'client', provider: 'apple', label: 'macOS Infra App',    layer: 'client', statusSource: 'static', description: 'This control panel — calls /api/infra/*' },

  // ── Edge layer ───────────────────────────────────────────────────────────
  { id: 'dns', type: 'dns', provider: 'namecheap', label: 'mixbase.app (DNS)', layer: 'edge', statusSource: 'static', description: 'Namecheap CNAME/ALIAS → Railway, SSL by Railway' },

  // ── App / compute layer ──────────────────────────────────────────────────
  { id: 'railway-prod',    type: 'compute', provider: 'railway', label: 'Railway · production', layer: 'app', statusSource: 'railway', description: 'Next.js (45 API routes) — mixbase.app' },
  { id: 'railway-staging', type: 'compute', provider: 'railway', label: 'Railway · staging',    layer: 'app', statusSource: 'railway', description: 'Next.js — mixbase-staging.up.railway.app' },

  // ── Data layer ───────────────────────────────────────────────────────────
  { id: 'supabase-db',      type: 'database', provider: 'supabase', label: 'Supabase Postgres', layer: 'data', statusSource: 'supabase', description: 'mb_* / sb_* tables, RLS, RPCs' },
  { id: 'supabase-storage', type: 'storage',  provider: 'supabase', label: 'Supabase Storage',  layer: 'data', statusSource: 'supabase', description: 'mf-audio (2GB) + mf-artwork (50MB) buckets' },
  { id: 'supabase-auth',    type: 'auth',     provider: 'supabase', label: 'Supabase Auth',     layer: 'data', statusSource: 'static',   description: 'Email + password, JWT sessions' },

  // ── External layer (drawn; live in phase 2) ──────────────────────────────
  { id: 'anthropic', type: 'external', provider: 'anthropic', label: 'Anthropic (Claude)', layer: 'external', statusSource: 'static', description: 'Feedback summarizer, finalize-artwork, admin chat' },
  { id: 'replicate', type: 'external', provider: 'replicate', label: 'Replicate',          layer: 'external', statusSource: 'static', description: 'Flux 2 Pro / Imagen 4 artwork generation' },
  { id: 'runway',    type: 'external', provider: 'runway',    label: 'Runway',             layer: 'external', statusSource: 'static', description: 'Gen-4 / Veo image-to-video visualizer' },
  { id: 'stripe',    type: 'external', provider: 'stripe',    label: 'Stripe',             layer: 'external', statusSource: 'static', description: 'Subscription billing (pro / studio)' },
  { id: 'sentry',    type: 'monitor',  provider: 'sentry',    label: 'Sentry',             layer: 'external', statusSource: 'static', description: 'Error monitoring (moodmixformat/mixbase)' },
  { id: 'github',    type: 'ci',       provider: 'github',    label: 'GitHub Actions',     layer: 'external', statusSource: 'static', description: 'CI: build/lint, gitleaks, audit → auto-deploy' },
]

export const INFRA_EDGES: InfraEdge[] = [
  // client → edge / app
  { from: 'web',   to: 'dns',           kind: 'http',  label: 'HTTPS' },
  { from: 'ios',   to: 'railway-prod',  kind: 'http',  label: 'API + Supabase' },
  { from: 'macos', to: 'railway-prod',  kind: 'http',  label: '/api/infra/*' },

  // edge → app
  { from: 'dns', to: 'railway-prod', kind: 'http', label: 'proxy' },

  // CI → app (deploys)
  { from: 'github', to: 'railway-prod',    kind: 'deploy', label: 'main' },
  { from: 'github', to: 'railway-staging', kind: 'deploy', label: 'tst' },

  // app → data
  { from: 'railway-prod',    to: 'supabase-db',      kind: 'sql',     label: 'Postgres' },
  { from: 'railway-prod',    to: 'supabase-storage', kind: 'storage', label: 'TUS / signed URL' },
  { from: 'railway-prod',    to: 'supabase-auth',    kind: 'auth',    label: 'sign-in' },
  { from: 'railway-staging', to: 'supabase-db',      kind: 'sql',     label: 'Postgres' },

  // app → external
  { from: 'railway-prod', to: 'anthropic', kind: 'http',    label: 'messages' },
  { from: 'railway-prod', to: 'replicate', kind: 'http',    label: 'predictions' },
  { from: 'railway-prod', to: 'runway',    kind: 'http',    label: 'video' },
  { from: 'railway-prod', to: 'stripe',    kind: 'webhook', label: 'checkout / webhook' },
  { from: 'railway-prod', to: 'sentry',    kind: 'http',    label: 'errors' },
]

// Stable column order for the layered layout consumed by the macOS canvas.
export const LAYER_ORDER: InfraLayer[] = ['client', 'edge', 'app', 'data', 'external']
