"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FilterBar } from "@/components/FilterBar";
import { ConfidenceBadge } from "@/components/ConfidenceBadge";
import { useToast } from "@/components/Toaster";
import { supabase, useCurators, useTracks, useUserId } from "@/lib/hooks";
import { EMPTY_FILTERS, allGenres, applyFilters } from "@/lib/filter";
import { loadTemplate, renderTemplate, splitSubjectBody } from "@/lib/template";
import {
  actionLabel,
  buildMailto,
  copyToClipboard,
  resolveSend,
} from "@/lib/send";
import { BATCH_SEND_CAP } from "@/lib/config";
import type { Curator } from "@/lib/types";

export default function SubmitPage() {
  const { curators } = useCurators();
  const { tracks } = useTracks();
  const userId = useUserId();
  const toast = useToast();

  const [trackId, setTrackId] = useState("");
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<"select" | "review">("select");
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [batchEnabled, setBatchEnabled] = useState(false);
  const [batching, setBatching] = useState(false);

  const track = tracks.find((t) => t.id === trackId);
  const genres = useMemo(() => allGenres(curators), [curators]);
  const filtered = useMemo(
    () => applyFilters(curators, filters),
    [curators, filters],
  );
  const selectedCurators = useMemo(
    () => curators.filter((c) => selected.has(c.id)),
    [curators, selected],
  );

  // Detect whether Mode B (Resend batch email) is configured on the server.
  useEffect(() => {
    fetch("/api/send-email")
      .then((r) => r.json())
      .then((d) => setBatchEnabled(!!d.enabled))
      .catch(() => setBatchEnabled(false));
  }, []);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      filtered.forEach((c) => next.add(c.id));
      return next;
    });
  }

  function goReview() {
    if (!track) return toast("Pick a track first.", "warn");
    if (selected.size === 0) return toast("Select at least one curator.", "warn");
    const tpl = loadTemplate();
    setMessages((prev) => {
      const next = { ...prev };
      for (const c of selectedCurators) {
        if (!next[c.id]) next[c.id] = renderTemplate(tpl, c, track);
      }
      return next;
    });
    setStep("review");
    window.scrollTo({ top: 0 });
  }

  // Write a submissions row and best-effort bump the curator's last_contacted.
  async function logSubmission(curator: Curator, message: string) {
    const { channel } = resolveSend(curator);
    const { error } = await supabase.from("submissions").insert({
      track_id: trackId,
      curator_id: curator.id,
      channel,
      message,
      status: "sent",
      sent_at: new Date().toISOString(),
    });
    if (error) {
      toast(`Could not log ${curator.name}: ${error.message}`, "error");
      return false;
    }
    // last_contacted only updates for the user's OWN rows (RLS blocks shared
    // rows harmlessly); curator history is derived from submissions regardless.
    if (curator.user_id && curator.user_id === userId) {
      await supabase
        .from("curators")
        .update({ last_contacted: new Date().toISOString() })
        .eq("id", curator.id);
    }
    setSent((prev) => new Set(prev).add(curator.id));
    return true;
  }

  async function doAction(curator: Curator) {
    const message = messages[curator.id] ?? "";
    const { kind } = resolveSend(curator);
    const { subject, body } = splitSubjectBody(message);

    if (kind === "email") {
      window.location.assign(
        buildMailto(curator.contact_value ?? "", subject, body),
      );
    } else if (kind === "spotify") {
      window.open(curator.contact_value ?? "", "_blank", "noopener");
      toast("Pitch ONE unreleased song 2-4 weeks early in Spotify for Artists.");
    } else {
      // form / social → copy message, open the channel for manual paste.
      const ok = await copyToClipboard(message);
      window.open(curator.contact_value ?? "", "_blank", "noopener");
      toast(ok ? "Message copied — paste it on the page." : "Open the page and paste your message.");
    }
    await logSubmission(curator, message);
  }

  async function batchSendEmails() {
    const emailCurators = selectedCurators.filter(
      (c) => resolveSend(c).kind === "email" && !sent.has(c.id),
    );
    if (emailCurators.length === 0) return toast("No pending email curators.", "warn");

    setBatching(true);
    const items = emailCurators.slice(0, BATCH_SEND_CAP).map((c) => {
      const { subject, body } = splitSubjectBody(messages[c.id] ?? "");
      return { curatorId: c.id, to: c.contact_value, subject, body };
    });

    try {
      const res = await fetch("/api/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data.error ?? "Batch send failed.", "error");
        return;
      }
      let okCount = 0;
      for (const r of data.results as { curatorId: string; ok: boolean }[]) {
        const curator = emailCurators.find((c) => c.id === r.curatorId);
        if (r.ok && curator) {
          okCount++;
          await logSubmission(curator, messages[curator.id] ?? "");
        }
      }
      toast(`Sent ${okCount}/${items.length} emails via Resend.`);
    } catch {
      toast("Batch send failed (network).", "error");
    } finally {
      setBatching(false);
    }
  }

  // ─── Step 1: select ───
  if (step === "select") {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-semibold tracking-tight">Submit a track</h1>

        <div className="card p-4">
          <label className="label">Track to pitch</label>
          {tracks.length === 0 ? (
            <p className="text-sm text-muted">
              No tracks yet —{" "}
              <Link href="/tracks" className="text-white underline">
                add one first
              </Link>
              .
            </p>
          ) : (
            <select
              className="input"
              value={trackId}
              onChange={(e) => setTrackId(e.target.value)}
            >
              <option value="">Select a track…</option>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                  {t.genre ? ` · ${t.genre}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>

        <FilterBar
          filters={filters}
          setFilters={setFilters}
          genres={genres}
          resultCount={filtered.length}
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            <button onClick={selectAllFiltered} className="btn-ghost btn-sm">
              Select all filtered ({filtered.length})
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="btn-ghost btn-sm"
            >
              Clear ({selected.size})
            </button>
          </div>
          <button
            onClick={goReview}
            disabled={!trackId || selected.size === 0}
            className="btn-primary"
          >
            Review {selected.size} selected →
          </button>
        </div>

        <div className="space-y-2">
          {filtered.map((c) => {
            const checked = selected.has(c.id);
            return (
              <label
                key={c.id}
                className={`card flex cursor-pointer items-center gap-3 p-3 ${
                  checked ? "border-accent" : ""
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(c.id)}
                  className="h-4 w-4 accent-accent"
                />
                <span className="flex-1">
                  <span className="font-medium">{c.name}</span>
                  <span className="ml-2 text-xs text-muted">
                    {c.type} · {c.contact_method}
                  </span>
                </span>
                <ConfidenceBadge
                  confidence={c.confidence}
                  sourceUrl={c.source_url}
                />
              </label>
            );
          })}
        </div>
      </div>
    );
  }

  // ─── Step 2: review + send ───
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Review &amp; send
          </h1>
          <p className="text-sm text-muted">
            Pitching <span className="text-white">{track?.title}</span> to{" "}
            {selectedCurators.length} curators. Edit any message before sending.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setStep("select")} className="btn-ghost">
            ← Back
          </button>
          {batchEnabled && (
            <button
              onClick={batchSendEmails}
              disabled={batching}
              className="btn-primary"
            >
              {batching ? "Sending…" : "Batch-send emails (Resend)"}
            </button>
          )}
        </div>
      </div>

      <div className="space-y-3">
        {selectedCurators.map((c) => {
          const done = sent.has(c.id);
          return (
            <div
              key={c.id}
              className={`card p-4 ${done ? "opacity-60" : ""}`}
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  <span className="chip">{c.contact_method}</span>
                  {done && (
                    <span className="rounded-full bg-ok-dim px-2 py-0.5 text-xs text-ok">
                      ✓ logged
                    </span>
                  )}
                </div>
                <ConfidenceBadge
                  confidence={c.confidence}
                  sourceUrl={c.source_url}
                />
              </div>

              {c.confidence === "UNVERIFIED" && (
                <div className="mb-2 rounded-lg border border-warn bg-warn-dim px-3 py-2 text-xs text-warn">
                  ⚠ Unverified channel — confirm at{" "}
                  {c.source_url ? (
                    <a
                      href={c.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      the source
                    </a>
                  ) : (
                    "the source"
                  )}{" "}
                  before sending.
                </div>
              )}

              {c.guidelines && (
                <p className="mb-2 text-xs text-muted">
                  <span className="font-medium text-white">Guidelines:</span>{" "}
                  {c.guidelines}
                </p>
              )}

              <textarea
                className="input min-h-[150px] font-mono text-xs"
                value={messages[c.id] ?? ""}
                onChange={(e) =>
                  setMessages((m) => ({ ...m, [c.id]: e.target.value }))
                }
              />

              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-xs text-muted break-all">
                  → {c.contact_value}
                </span>
                <button onClick={() => doAction(c)} className="btn-primary btn-sm">
                  {actionLabel(c)}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
