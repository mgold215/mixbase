'use client'
import { useState, useRef, useEffect } from 'react'
import { Send } from 'lucide-react'

type Message = {
  role: 'user' | 'assistant'
  text: string
  toolLog?: { tool: string; result: string }[]
}

export default function AdminAssistantPage() {
  const [messages, setMessages] = useState<Message[]>([{
    role: 'assistant',
    text: 'Hi — I can help you manage users, check usage stats, and run admin actions. What do you need?',
  }])
  const [input, setInput]   = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function send(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || loading) return

    const userMsg: Message = { role: 'user', text }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    // Build the messages array for the API (exclude the initial greeting)
    const apiMessages = [...messages.slice(1), userMsg]
      .map(m => ({ role: m.role, content: m.text }))

    try {
      const res = await fetch('/api/admin/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages }),
      })
      if (!res.ok) {
        setMessages(prev => [...prev, { role: 'assistant', text: 'Request failed. Check your session and try again.' }])
        setLoading(false)
        return
      }
      const data = await res.json()
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: data.text ?? 'Done.',
        toolLog: data.toolLog?.length ? data.toolLog : undefined,
      }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', text: 'Something went wrong. Try again.' }])
    }
    setLoading(false)
  }

  return (
    <div className="flex flex-col h-[600px]">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-2 pb-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className="max-w-[80%] rounded-2xl px-4 py-3 text-sm"
              style={{
                background: m.role === 'user' ? '#2dd4bf' : 'var(--surface)',
                color:      m.role === 'user' ? '#0a0a0a'  : 'var(--text)',
                border:     m.role === 'assistant' ? '1px solid var(--border)' : 'none',
              }}
            >
              <p className="whitespace-pre-wrap">{m.text}</p>
              {m.toolLog && m.toolLog.length > 0 && (
                <div className="mt-2 space-y-1">
                  {m.toolLog.map((t, j) => (
                    <div key={j} className="flex items-start gap-2 text-xs" style={{ color: '#2dd4bf' }}>
                      <span className="flex-shrink-0">✓</span>
                      <span className="font-mono">{t.tool}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-2xl px-4 py-3 text-sm" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
              Thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form onSubmit={send} className="flex gap-2 pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask anything or give an instruction…"
          disabled={loading}
          className="flex-1 text-sm px-4 py-2.5 rounded-xl outline-none"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="px-4 py-2.5 rounded-xl font-medium disabled:opacity-40 transition-colors"
          style={{ background: '#2dd4bf', color: '#0a0a0a' }}
        >
          <Send size={15} />
        </button>
      </form>
    </div>
  )
}
