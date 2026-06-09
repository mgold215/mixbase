import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { assertAdmin } from '@/lib/auth'
import { SUPABASE_URL } from '@/lib/supabase'
import { INFRA_NODES, INFRA_EDGES } from '@/lib/infra/topology'
import { getRailwayStatus } from '@/lib/infra/railway'
import { getSupabaseStatus } from '@/lib/infra/supabase'

export const dynamic = 'force-dynamic'

// Read-only tools only. The infra assistant can observe but never mutate.
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_topology',
    description: 'Get the full architecture graph: every node (service/db/storage/external) and the data-flow edges between them.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_railway_status',
    description: 'Get Railway environment status: production & staging app liveness (health), latest deployment status, and project info.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_supabase_status',
    description: 'Get Supabase status: per-table row counts, storage bucket usage vs limits, database size, applied migrations, and scaling signals.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'run_readonly_sql',
    description: 'Run a single read-only SQL statement (SELECT / EXPLAIN / WITH only) against the Postgres database and return the rows. Use for ad-hoc questions the other tools cannot answer. Never attempt writes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        sql: { type: 'string', description: 'A single read-only SQL statement (must begin with SELECT, WITH, or EXPLAIN).' },
      },
      required: ['sql'],
    },
  },
]

// Guard: only allow a single read-only statement. Rejects writes, DDL, and
// statement chaining before the query ever reaches the database.
function isReadonlySql(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  if (trimmed.includes(';')) return false // no statement chaining
  if (!/^(select|with|explain)\b/i.test(trimmed)) return false
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do)\b/i.test(trimmed)) return false
  return true
}

async function runReadonlySql(sql: string): Promise<string> {
  if (!isReadonlySql(sql)) return 'Rejected: only a single read-only SELECT/WITH/EXPLAIN statement is allowed.'
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN
  const ref = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '')
  if (!token) return 'SUPABASE_MANAGEMENT_TOKEN is not configured, so ad-hoc SQL is unavailable. Use the other tools instead.'
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
      cache: 'no-store',
    })
    const json = await res.json()
    if (!res.ok) return `SQL error: ${typeof json === 'object' ? JSON.stringify(json) : String(json)}`
    return JSON.stringify(json).slice(0, 4000)
  } catch (e) {
    return `SQL error: ${e instanceof Error ? e.message : 'query failed'}`
  }
}

async function executeTool(name: string, input: Record<string, unknown> = {}): Promise<string> {
  try {
    if (name === 'get_topology') {
      return JSON.stringify({ nodes: INFRA_NODES, edges: INFRA_EDGES }).slice(0, 6000)
    }
    if (name === 'get_railway_status') {
      return JSON.stringify(await getRailwayStatus()).slice(0, 6000)
    }
    if (name === 'get_supabase_status') {
      return JSON.stringify(await getSupabaseStatus()).slice(0, 6000)
    }
    if (name === 'run_readonly_sql') {
      return runReadonlySql(String(input.sql ?? ''))
    }
    return `Unknown tool: ${name}`
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : 'Unknown error'}`
  }
}

export async function POST(request: NextRequest) {
  const adminId = await assertAdmin(request)
  if (!adminId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({
      text: 'The infra assistant is disabled because ANTHROPIC_API_KEY is not set. Set it in the Railway env vars to enable natural-language queries.',
      toolLog: [],
    })
  }

  const { messages } = await request.json()
  if (!Array.isArray(messages) || messages.length > 50) {
    return NextResponse.json({ error: 'Invalid messages' }, { status: 400 })
  }

  const client = new Anthropic()

  const systemPrompt = `You are the infrastructure assistant for mixBase, a Next.js app on Railway backed by Supabase. Today is ${new Date().toISOString().split('T')[0]}.

You have READ-ONLY tools to inspect the live architecture: the topology graph, Railway environment/deploy/health status, and Supabase row counts, storage usage, database size, and scaling signals. There is also a read-only SQL tool for ad-hoc questions.

Rules:
- You can only observe. You cannot change, scale, restart, or delete anything. If asked to take an action, explain what you see and what the user would need to do, but never claim to have changed anything.
- Be concise and concrete. Lead with the number or status that answers the question.
- When a metric is near its limit (a scaling signal at warn/critical), call it out.
- If a provider reports configured:false, say so plainly (the token isn't set) rather than guessing.`

  const msgs: Anthropic.MessageParam[] = messages
  let finalText = ''
  const toolLog: { tool: string; result: string }[] = []

  for (let i = 0; i < 5; i++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages: msgs,
    })

    msgs.push({ role: 'assistant', content: response.content })

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find((b) => b.type === 'text')
      finalText = textBlock?.type === 'text' ? textBlock.text : ''
      break
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue
        const result = await executeTool(block.name, block.input as Record<string, unknown>)
        toolLog.push({ tool: block.name, result: result.slice(0, 500) })
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
      }
      msgs.push({ role: 'user', content: toolResults })
    }
  }

  if (!finalText) finalText = 'I reached the maximum number of steps. Please try a simpler request.'
  return NextResponse.json({ text: finalText, toolLog })
}
