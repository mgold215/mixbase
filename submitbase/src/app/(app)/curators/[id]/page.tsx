"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ConfidenceBadge } from "@/components/ConfidenceBadge";
import { supabase, useSubmissions, useTracks } from "@/lib/hooks";
import { resolveSend } from "@/lib/send";
import type { Curator } from "@/lib/types";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border py-3 last:border-0">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

export default function CuratorDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [curator, setCurator] = useState<Curator | null>(null);
  const [loading, setLoading] = useState(true);
  const { submissions } = useSubmissions();
  const { tracks } = useTracks();

  useEffect(() => {
    supabase
      .from("curators")
      .select("*")
      .eq("id", id)
      .maybeSingle()
      .then(({ data }) => {
        setCurator(data as Curator | null);
        setLoading(false);
      });
  }, [id]);

  const history = useMemo(
    () => submissions.filter((s) => s.curator_id === id),
    [submissions, id],
  );
  const trackTitle = (tid: string | null) =>
    tracks.find((t) => t.id === tid)?.title ?? "—";

  if (loading) return <p className="py-10 text-center text-muted">Loading…</p>;
  if (!curator)
    return (
      <div className="py-10 text-center text-muted">
        Curator not found.{" "}
        <Link href="/" className="text-white underline">
          Back to directory
        </Link>
      </div>
    );

  const channel = resolveSend(curator);
  const contactHref =
    channel.kind === "email"
      ? `mailto:${curator.contact_value}`
      : curator.contact_value ?? "#";

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link href="/" className="text-sm text-muted hover:text-white">
        ← Directory
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {curator.name}
          </h1>
          <p className="text-sm text-muted">
            {curator.type} · {curator.platform}
          </p>
        </div>
        <ConfidenceBadge
          confidence={curator.confidence}
          sourceUrl={curator.source_url}
        />
      </div>

      {curator.confidence === "UNVERIFIED" && (
        <div className="rounded-xl border border-warn bg-warn-dim p-3 text-sm text-warn">
          ⚠ Unverified channel — open the source link and confirm the address
          still works before sending.
        </div>
      )}

      <div className="card px-5 py-2">
        <Field label="Genres">
          <div className="flex flex-wrap gap-1">
            {(curator.genres ?? []).map((g) => (
              <span key={g} className="chip">
                {g}
              </span>
            ))}
          </div>
        </Field>
        <Field label="Contact method">{curator.contact_method}</Field>
        <Field label="Contact value">
          <a
            href={contactHref}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-white underline"
          >
            {curator.contact_value}
          </a>
        </Field>
        <Field label="Guidelines">{curator.guidelines || "—"}</Field>
        <Field label="Accepts submissions">
          {curator.accepts_submissions ? "Yes" : "No"}
        </Field>
        {curator.audience_size != null && (
          <Field label="Audience size">
            {curator.audience_size.toLocaleString()}
          </Field>
        )}
        <Field label="Source">
          {curator.source_url ? (
            <a
              href={curator.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-white underline"
            >
              {curator.source_url}
            </a>
          ) : (
            "—"
          )}
        </Field>
        {curator.notes && <Field label="Your notes">{curator.notes}</Field>}
      </div>

      <div>
        <Link href="/submit" className="btn-primary">
          Submit a track to {curator.name}
        </Link>
      </div>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Submission history</h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted">No submissions to this curator yet.</p>
        ) : (
          <div className="space-y-2">
            {history.map((s) => (
              <div
                key={s.id}
                className="card flex items-center justify-between p-3 text-sm"
              >
                <span>{trackTitle(s.track_id)}</span>
                <span className="flex items-center gap-3 text-muted">
                  <span className="chip">{s.channel}</span>
                  <span className="chip">{s.status}</span>
                  <span>
                    {s.sent_at
                      ? new Date(s.sent_at).toLocaleDateString()
                      : new Date(s.created_at).toLocaleDateString()}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
