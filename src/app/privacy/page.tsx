import Link from 'next/link'

export const metadata = {
  title: 'Privacy Policy — mixBase',
  description: 'How mixBase collects, uses, and protects your information.',
}

export default function PrivacyPage() {
  const updated = 'April 23, 2026'
  const contact = 'privacy@mixbase.app'

  return (
    <div className="min-h-screen px-4 py-12" style={{ backgroundColor: 'var(--bg-page)', color: 'var(--text)' }}>
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="mb-10">
          <Link href="/dashboard" className="text-sm hover:underline" style={{ color: 'var(--accent)' }}>
            ← Back to mixBase
          </Link>
          <h1 className="text-3xl font-bold mt-4" style={{ fontFamily: 'var(--font-bebas)' }}>
            Privacy Policy
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Last updated: {updated}</p>
        </div>

        <div className="space-y-8 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>1. Who we are</h2>
            <p>
              mixBase (&quot;we&quot;, &quot;our&quot;, &quot;the app&quot;) is a music version-control and release-management tool.
              We are operated as an independent product. Questions can be directed to{' '}
              <a href={`mailto:${contact}`} style={{ color: 'var(--accent)' }}>{contact}</a>.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>2. Information we collect</h2>
            <ul className="list-disc list-inside space-y-1">
              <li><strong style={{ color: 'var(--text)' }}>Account data</strong> — your email address and hashed password, used to authenticate you.</li>
              <li><strong style={{ color: 'var(--text)' }}>Audio files</strong> — the audio files you upload. These are stored in Supabase cloud storage and are private to your account unless you explicitly share them.</li>
              <li><strong style={{ color: 'var(--text)' }}>Project metadata</strong> — titles, BPM, key, genre, notes, and release information you enter.</li>
              <li><strong style={{ color: 'var(--text)' }}>Artwork images</strong> — cover art you upload or generate via AI.</li>
              <li><strong style={{ color: 'var(--text)' }}>Feedback</strong> — comments left by collaborators on your shared tracks (includes the reviewer name they provide).</li>
              <li><strong style={{ color: 'var(--text)' }}>Usage data</strong> — standard server logs (IP address, request timestamps, response codes) retained for up to 30 days for debugging.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>3. How we use your information</h2>
            <ul className="list-disc list-inside space-y-1">
              <li>To operate and maintain your account and its associated music projects.</li>
              <li>To deliver core features: audio playback, version tracking, release pipeline, and share links.</li>
              <li>To send transactional emails (password reset, account notices) — we do not send marketing email.</li>
              <li>To diagnose technical issues using anonymised log data.</li>
            </ul>
            <p className="mt-2">We do not sell, rent, or share your personal data or audio files with third parties for advertising purposes.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>4. Third-party services</h2>
            <ul className="list-disc list-inside space-y-1">
              <li><strong style={{ color: 'var(--text)' }}>Supabase</strong> — database and file storage provider. Data is stored in the US-East-1 region. <a href="https://supabase.com/privacy" target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>Supabase Privacy Policy</a>.</li>
              <li><strong style={{ color: 'var(--text)' }}>Railway</strong> — application hosting. <a href="https://railway.app/legal/privacy" target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>Railway Privacy Policy</a>.</li>
              <li><strong style={{ color: 'var(--text)' }}>Replicate</strong> — optional AI artwork generation. Only invoked when you explicitly request artwork generation; your prompts are sent to Replicate&apos;s API. <a href="https://replicate.com/privacy" target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>Replicate Privacy Policy</a>.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>5. Data retention</h2>
            <p>
              Your account and all associated data (projects, audio files, artwork) are retained for as long as your account is active.
              You may delete individual projects, versions, or your entire account at any time. Deleted audio files are removed from storage within 24 hours.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>6. Security</h2>
            <p>
              All data is transmitted over HTTPS. Passwords are hashed by Supabase Auth using bcrypt and are never stored in plaintext.
              Audio files are stored in private Supabase buckets; public URLs are only generated when you create a share link.
              Share links expire when you delete the corresponding version.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>7. Your rights</h2>
            <p>Depending on your jurisdiction you may have the right to:</p>
            <ul className="list-disc list-inside space-y-1 mt-1">
              <li>Access the personal data we hold about you.</li>
              <li>Correct inaccurate data.</li>
              <li>Request deletion of your account and all associated data.</li>
              <li>Export your data in a portable format.</li>
            </ul>
            <p className="mt-2">
              To exercise any of these rights, email <a href={`mailto:${contact}`} style={{ color: 'var(--accent)' }}>{contact}</a>.
              We will respond within 30 days.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>8. Children</h2>
            <p>
              mixBase is not directed at children under 13 (or under 16 in the EU). We do not knowingly collect
              personal data from children. If you believe a child has created an account, contact us and we will delete it promptly.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>9. Changes to this policy</h2>
            <p>
              We may update this policy occasionally. Material changes will be communicated via the email address on your account.
              The &quot;last updated&quot; date at the top of this page always reflects the current version.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>10. Contact</h2>
            <p>
              Privacy questions or requests: <a href={`mailto:${contact}`} style={{ color: 'var(--accent)' }}>{contact}</a>
            </p>
          </section>

        </div>
      </div>
    </div>
  )
}
