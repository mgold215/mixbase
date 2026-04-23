import Link from 'next/link'

export const metadata = {
  title: 'Terms of Service — mixBase',
  description: 'Terms governing your use of mixBase.',
}

export default function TermsPage() {
  const updated = 'April 23, 2026'
  const contact = 'legal@mixbase.app'

  return (
    <div className="min-h-screen px-4 py-12" style={{ backgroundColor: 'var(--bg-page)', color: 'var(--text)' }}>
      <div className="max-w-2xl mx-auto">

        <div className="mb-10">
          <Link href="/dashboard" className="text-sm hover:underline" style={{ color: 'var(--accent)' }}>
            ← Back to mixBase
          </Link>
          <h1 className="text-3xl font-bold mt-4" style={{ fontFamily: 'var(--font-bebas)' }}>
            Terms of Service
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Last updated: {updated}</p>
        </div>

        <div className="space-y-8 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>1. Acceptance</h2>
            <p>
              By creating an account or using mixBase (&quot;Service&quot;, &quot;we&quot;, &quot;our&quot;), you agree to these Terms. If you do not agree, do not use the Service.
              These Terms form a binding agreement between you and mixBase.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>2. Eligibility</h2>
            <p>You must be at least 13 years old (16 in the EU/EEA) to use mixBase. By using the Service you represent that you meet this requirement.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>3. Your content</h2>
            <p className="mb-2">
              You retain full ownership of all audio files, artwork, notes, and other content you upload (&quot;User Content&quot;).
              By uploading User Content you grant mixBase a limited, worldwide, royalty-free license to store, process, and display your content solely to operate and improve the Service.
              This license ends when you delete the content or close your account.
            </p>
            <p>
              You represent that you own or have all necessary rights to the User Content you upload, and that uploading it does not infringe any third-party rights.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>4. Acceptable use</h2>
            <p className="mb-2">You agree not to:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Upload content you do not have rights to (e.g., commercially released music you do not own)</li>
              <li>Use the Service to infringe any intellectual property rights</li>
              <li>Attempt to access other users&apos; accounts or data</li>
              <li>Use automated tools to scrape, crawl, or overload our infrastructure</li>
              <li>Circumvent any security or access control measures</li>
              <li>Use the Service for any illegal purpose</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>5. Copyright / DMCA</h2>
            <p className="mb-2">
              mixBase respects intellectual property rights and complies with the Digital Millennium Copyright Act (17 U.S.C. § 512).
              If you believe content on our platform infringes your copyright, please submit a notice to our designated agent at{' '}
              <Link href="/dmca" style={{ color: 'var(--accent)' }}>mixbase.app/dmca</Link>.
            </p>
            <p>
              We will respond to valid notices by removing or disabling access to the allegedly infringing content.
              Accounts that repeatedly infringe copyrights will be terminated.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>6. Share links</h2>
            <p>
              When you generate a share link for a version, that link becomes accessible to anyone who has it. You control which versions have share links and can revoke access at any time by deleting the version.
              You are responsible for deciding what you share and with whom.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>7. Account and security</h2>
            <p>
              You are responsible for maintaining the security of your account credentials.
              Notify us immediately at <a href={`mailto:${contact}`} style={{ color: 'var(--accent)' }}>{contact}</a> if you suspect unauthorized access.
              We are not liable for losses resulting from unauthorized use of your account.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>8. Subscriptions and billing</h2>
            <p>
              If you subscribe to a paid plan, you authorize us to charge your payment method on a recurring basis.
              Subscriptions auto-renew unless cancelled at least 24 hours before the renewal date.
              Refunds are handled on a case-by-case basis — contact{' '}
              <a href={`mailto:${contact}`} style={{ color: 'var(--accent)' }}>{contact}</a>.
              Prices may change with 30 days&apos; notice.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>9. Disclaimers</h2>
            <p className="uppercase text-xs mb-2" style={{ letterSpacing: '0.05em' }}>
              The Service is provided &quot;as is&quot; without warranty of any kind. We do not guarantee uninterrupted availability, freedom from bugs, or that your content will never be lost. Back up content you care about.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>10. Limitation of liability</h2>
            <p>
              To the maximum extent permitted by law, mixBase&apos;s liability to you for any claim arising from these Terms or your use of the Service is limited to the greater of (a) the amount you paid us in the 12 months preceding the claim or (b) $100.
              We are not liable for indirect, consequential, punitive, or special damages.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>11. Indemnification</h2>
            <p>
              You agree to indemnify and hold harmless mixBase and its affiliates from any claims, losses, or expenses (including legal fees) arising from your User Content, your violation of these Terms, or your infringement of any third-party rights.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>12. Termination</h2>
            <p>
              We may suspend or terminate your account for material violation of these Terms, including copyright infringement, with or without notice.
              You may close your account at any time by contacting <a href={`mailto:${contact}`} style={{ color: 'var(--accent)' }}>{contact}</a>.
              Upon termination, your content will be deleted within 30 days.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>13. Governing law</h2>
            <p>
              These Terms are governed by the laws of the United States. Disputes will be resolved in the courts of competent jurisdiction.
              If any provision is found unenforceable, the remainder continues in effect.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>14. Changes</h2>
            <p>
              We may update these Terms. Material changes will be communicated by email or prominent notice in the app at least 14 days before taking effect.
              Continued use after the effective date constitutes acceptance.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>15. Contact</h2>
            <p>
              Legal questions: <a href={`mailto:${contact}`} style={{ color: 'var(--accent)' }}>{contact}</a>
            </p>
          </section>

        </div>

        <p className="text-center text-xs mt-10" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>
          <Link href="/privacy" style={{ color: 'var(--accent)' }} className="hover:underline">Privacy Policy</Link>
          {' · '}
          <Link href="/dmca" style={{ color: 'var(--accent)' }} className="hover:underline">DMCA</Link>
        </p>

      </div>
    </div>
  )
}
