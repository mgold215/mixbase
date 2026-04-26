import Link from 'next/link'

export const metadata = {
  title: 'Support — mixBase',
  description: 'Get help with mixBase.',
}

export default function SupportPage() {
  const contact = 'support@mixbase.app'

  const faqs = [
    {
      q: 'How do I upload a new version of a track?',
      a: 'Open a project, then tap or click "Upload new version". Select your audio file (WAV, MP3, FLAC, M4A, AAC, or OGG up to 500 MB). The file uploads directly to secure cloud storage — large files are handled automatically.',
    },
    {
      q: 'How do share links work?',
      a: 'On any version, tap "Share". This generates a unique link anyone can open in a browser — no account required. Listeners can play the track and leave timestamped feedback. You can revoke access by deleting the version.',
    },
    {
      q: 'Can I download my audio files?',
      a: 'Yes. On any version you can enable "Allow download" so listeners on your share page can download the file. Your own files are always accessible from within the app.',
    },
    {
      q: 'What audio formats are supported?',
      a: 'WAV, MP3, FLAC, M4A, AAC, and OGG. For best quality we recommend uploading lossless WAV or FLAC masters and keeping compressed versions for share links.',
    },
    {
      q: 'How do I generate AI artwork?',
      a: 'Open a project and tap "Generate Artwork". Describe the vibe of the track and mixBase will generate multiple options using AI (Flux / Imagen). You can regenerate as many times as you like.',
    },
    {
      q: 'What is the Pipeline?',
      a: 'The Pipeline is a release checklist. Add a release, then track milestones like mixing, mastering, artwork, DSP submission, and social posts — all in one place.',
    },
    {
      q: 'How do I delete my account?',
      a: `Email ${contact} with the subject "Delete my account". We will remove all your data — projects, audio files, artwork, and account credentials — within 7 days and confirm by email.`,
    },
    {
      q: 'Is there a storage limit?',
      a: 'During early access there is no hard storage cap per account. We reserve the right to introduce fair-use limits in the future and will notify you well in advance.',
    },
  ]

  return (
    <div className="min-h-screen px-4 py-12" style={{ backgroundColor: 'var(--bg-page)', color: 'var(--text)' }}>
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="mb-10">
          <Link href="/dashboard" className="text-sm hover:underline" style={{ color: 'var(--accent)' }}>
            ← Back to mixBase
          </Link>
          <h1 className="text-3xl font-bold mt-4" style={{ fontFamily: 'var(--font-bebas)' }}>
            Support
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Questions? We&apos;re here to help.{' '}
            <a href={`mailto:${contact}`} style={{ color: 'var(--accent)' }}>{contact}</a>
          </p>
        </div>

        {/* FAQ */}
        <div className="space-y-6">
          {faqs.map((faq, i) => (
            <div
              key={i}
              className="rounded-xl p-5"
              style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
            >
              <h2 className="font-semibold text-sm mb-2" style={{ color: 'var(--text)' }}>{faq.q}</h2>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{faq.a}</p>
            </div>
          ))}
        </div>

        {/* Contact CTA */}
        <div
          className="mt-10 rounded-xl p-6 text-center"
          style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <h2 className="font-semibold mb-2" style={{ color: 'var(--text)' }}>Still stuck?</h2>
          <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
            Send us a message and we&apos;ll get back to you within 24 hours.
          </p>
          <a
            href={`mailto:${contact}`}
            className="inline-block font-semibold text-sm px-6 py-3 rounded-xl"
            style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
          >
            Email support
          </a>
        </div>

        <p className="text-center text-xs mt-8" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>
          <Link href="/privacy" style={{ color: 'var(--accent)' }} className="hover:underline">Privacy Policy</Link>
        </p>

      </div>
    </div>
  )
}
