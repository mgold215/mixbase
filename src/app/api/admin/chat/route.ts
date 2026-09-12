import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin } from '@/lib/supabase'
import { currentMonth } from '@/lib/tier'
import { assertAdmin } from '@/lib/auth'

const client = new Anthropic()

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_users',
    description: 'List all user accounts with this month\'s usage.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_stats',
    description: 'Get aggregate stats: total users and total generations this month.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'reset_user_usage',
    description: 'Reset a user\'s generation usage for the current month to zero.',
    input_schema: {
      type: 'object' as const,
      properties: {
        email: { type: 'string', description: 'User email address' },
      },
      required: ['email'],
    },
  },
  {
    name: 'create_user',
    description: 'Create a new user account.',
    input_schema: {
      type: 'object' as const,
      properties: {
        email:    { type: 'string' },
        password: { type: 'string' },
      },
      required: ['email', 'password'],
    },
  },
  {
    name: 'delete_user',
    description: 'Permanently delete a user account. ALWAYS confirm with the user before calling this.',
    input_schema: {
      type: 'object' as const,
      properties: {
        email: { type: 'string', description: 'User email address' },
      },
      required: ['email'],
    },
  },
]

async function executeTool(name: string, input: Record<string, string>, requestingAdminId: string): Promise<string> {
  try {
    if (name === 'list_users') {
      const { data: listData, error: listError } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
      if (listError) return `Error listing users: ${listError.message}`
      const users = listData.users
      const usageRes = await supabaseAdmin.from('mb_usage').select('user_id, artwork_generations').eq('month', currentMonth())
      const usageMap = Object.fromEntries((usageRes.data ?? []).map(u => [u.user_id, u.artwork_generations]))
      const rows = users.map(u => `${u.email} | artwork: ${usageMap[u.id] ?? 0}`)
      return rows.join('\n')
    }

    if (name === 'get_stats') {
      const { data: listData, error: listError } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
      if (listError) return `Error: ${listError.message}`
      const usageRes    = await supabaseAdmin.from('mb_usage').select('artwork_generations, video_generations').eq('month', currentMonth())
      const totalArtwork = (usageRes.data ?? []).reduce((s, r) => s + r.artwork_generations, 0)
      const totalVideo   = (usageRes.data ?? []).reduce((s, r) => s + r.video_generations,   0)
      return JSON.stringify({ total_users: listData.users.length, artwork_this_month: totalArtwork, video_this_month: totalVideo })
    }

    if (name === 'reset_user_usage') {
      const { data: listData, error: listError } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
      if (listError) return `Error: ${listError.message}`
      const user = listData.users.find(u => u.email === input.email)
      if (!user) return `User not found: ${input.email}`
      await supabaseAdmin.from('mb_usage').delete().eq('user_id', user.id).eq('month', currentMonth())
      return `Reset usage for ${input.email}`
    }

    if (name === 'create_user') {
      const { error } = await supabaseAdmin.auth.admin.createUser({
        email: input.email, password: input.password, email_confirm: true,
      })
      if (error) return `Error: ${error.message}`
      return `Created account for ${input.email}`
    }

    if (name === 'delete_user') {
      const { data: listData, error: listError } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
      if (listError) return `Error: ${listError.message}`
      const user = listData.users.find(u => u.email === input.email)
      if (!user) return `User not found: ${input.email}`
      if (user.id === requestingAdminId) return 'Cannot delete your own account.'
      const { error } = await supabaseAdmin.auth.admin.deleteUser(user.id)
      if (error) return `Error: ${error.message}`
      return `Deleted account for ${input.email}`
    }

    return `Unknown tool: ${name}`
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : 'Unknown error'}`
  }
}

export async function POST(request: NextRequest) {
  const adminId = await assertAdmin(request)
  if (!adminId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { messages } = body

  if (!Array.isArray(messages) || messages.length > 50) {
    return NextResponse.json({ error: 'Invalid messages' }, { status: 400 })
  }

  const systemPrompt = `You are the admin assistant for mixBase, a music mix versioning platform. Today is ${new Date().toISOString().split('T')[0]}.

You have tools to manage users (list, create, reset usage, delete). Use them to answer questions and execute admin actions.

Rules:
- Be concise. One or two sentences per response unless listing data.
- For delete_user: always describe what you're about to do and ask for confirmation before calling the tool, unless the user has already confirmed.
- When listing users, format the output clearly.
- If you don't understand a request, ask for clarification.`

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
      const textBlock = response.content.find(b => b.type === 'text')
      finalText = textBlock?.type === 'text' ? textBlock.text : ''
      break
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue
        const result = await executeTool(block.name, block.input as Record<string, string>, adminId)
        toolLog.push({ tool: block.name, result })
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
      }
      msgs.push({ role: 'user', content: toolResults })
    }
  }

  if (!finalText) finalText = 'I reached the maximum number of steps. Please try a simpler request.'

  return NextResponse.json({ text: finalText, toolLog })
}
