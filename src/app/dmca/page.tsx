import Link from 'next/link'

export const metadata = {
  title: 'DMCA Policy — mixBase',
  description: 'Copyright infringement notice and counter-notice procedures for mixBase.',
}

export default function DmcaPage() {
  const agentEmail = 'dmca@mixbase.app'
  const updated = 'April 23, 2026'

  return (
    <div className="min-h-screen px-4 py-12" style={{ backgroundColor: 'var(--bg-page)', color: 'var(--text)' }}>
      <div className="max-w-2xl mx-auto">

        <div className="mb-10">
          <Link href="/dashboard" className="text-sm hover:underline" style={{ color: 'var(--accent)' }}>
            ← Back to mixBase
          </Link>
          <h1 className="text-3xl font-bold mt-4" style={{ fontFamily: 'var(--font-bebas)' }}>
            DMCA Copyright Policy
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Last updated: {updated}</p>
        </div>

        <div className="space-y-8 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>

          <section>
            <p>
              mixBase respects the intellectual property rights of others and complies with the Digital Millennium Copyright Act (DMCA), 17 U.S.C. § 512.
              If you believe content on our platform infringes your copyright, you may submit a takedown notice to our Designated Copyright Agent using the procedure below.
            </p>
          </section>

          {/* Designated Agent */}
          <section
            className="rounded-xl p-5"
            style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            <h2 className="text-base font-semibold mb-3" style={{ color: 'var(--text)' }}>Designated Copyright Agent</h2>
            <div className="space-y-1" style={{ fontFamily: 'var(--font-mono)' }}>
              <p>mixBase Copyright Agent</p>
              <p>
                Email:{' '}
                <a href={`mailto:${agentEmail}`} style={{ color: 'var(--accent)' }}>{agentEmail}</a>
              </p>
            </div>
            <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
              This agent is registered with the U.S. Copyright Office pursuant to 17 U.S.C. § 512(c)(2).
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>How to submit a takedown notice</h2>
            <p className="mb-3">To be valid under the DMCA, your written notice must include all of the following:</p>
            <ol className="list-decimal list-inside space-y-2">
              <li>
                <strong style={{ color: 'var(--text)' }}>Your contact information</strong> — full legal name, mailing address, phone number, and email address.
              </li>
              <li>
                <strong style={{ color: 'var(--text)' }}>Identification of the copyrighted work</strong> — describe the work you claim is infringed, or provide a representative list if multiple works are covered.
              </li>
              <li>
                <strong style={{ color: 'var(--text)' }}>Identification of the infringing material</strong> — provide the URL or enough information for us to locate the specific content on mixBase.
              </li>
              <li>
                <strong style={{ color: 'var(--text)' }}>Good-faith statement</strong> — a statement that you have a good-faith belief that the use is not authorized by the copyright owner, its agent, or the law.
              </li>
              <li>
                <strong style={{ color: 'var(--text)' }}>Accuracy statement</strong> — a statement that the information in the notice is accurate and, under penalty of perjury, that you are authorized to act on behalf of the copyright owner.
              </li>
              <li>
                <strong style={{ color: 'var(--text)' }}>Physical or electronic signature</strong> — your full legal name typed as your signature is acceptable.
              </li>
            </ol>
            <p className="mt-3">
              Send the completed notice to <a href={`mailto:${agentEmail}`} style={{ color: 'var(--accent)' }}>{agentEmail}</a>.
              Incomplete notices may not be acted upon.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>What happens next</h2>
            <p>
              Upon receiving a complete and valid notice, we will expeditiously remove or disable access to the allegedly infringing content and notify the user who uploaded it.
              We will also forward a copy of your notice to that user (personal contact details will be redacted where possible).
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>Counter-notice procedure</h2>
            <p className="mb-3">
              If you believe your content was removed by mistake or misidentification, you may submit a counter-notice.
              A valid counter-notice must include:
            </p>
            <ol className="list-decimal list-inside space-y-2">
              <li>Your name, address, phone number, and email.</li>
              <li>Identification of the content that was removed and where it appeared before removal.</li>
              <li>A statement under penalty of perjury that you have a good-faith belief the content was removed as a result of mistake or misidentification.</li>
              <li>A statement that you consent to the jurisdiction of the Federal District Court for your district, and that you will accept service of process from the original complainant.</li>
              <li>Your physical or electronic signature.</li>
            </ol>
            <p className="mt-3">
              Send counter-notices to <a href={`mailto:${agentEmail}`} style={{ color: 'var(--accent)' }}>{agentEmail}</a>.
              Upon receiving a valid counter-notice, we will forward it to the original complainant. If the complainant does not file a court action within 10–14 business days, we may restore the content.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>Repeat infringer policy</h2>
            <p>
              In accordance with 17 U.S.C. § 512(i), mixBase will terminate the accounts of users who are found to be repeat infringers.
              We track takedown notices per account and apply this policy consistently.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>Abuse of this process</h2>
            <p>
              Knowingly submitting a false DMCA notice is a violation of 17 U.S.C. § 512(f) and may expose you to liability including damages and attorneys&apos; fees.
              Only submit a notice if you have a genuine, good-faith belief that the material is infringing.
            </p>
          </section>

        </div>

        <p className="text-center text-xs mt-10" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>
          <Link href="/terms" style={{ color: 'var(--accent)' }} className="hover:underline">Terms of Service</Link>
          {' · '}
          <Link href="/privacy" style={{ color: 'var(--accent)' }} className="hover:underline">Privacy Policy</Link>
        </p>

      </div>
    </div>
  )
}
