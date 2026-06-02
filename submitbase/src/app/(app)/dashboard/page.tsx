"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toaster";
import {
  supabase,
  useCurators,
  useSubmissions,
  useTracks,
} from "@/lib/hooks";
import { SUBMISSION_STATUSES, type SubmissionStatus } from "@/lib/types";

const RESPONDED: SubmissionStatus[] = ["responded", "accepted", "rejected"];

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card p-4">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
    </div>
  );
}

export default function DashboardPage() {
  const { submissions, loading, refresh } = useSubmissions();
  const { curators } = useCurators();
  const { tracks } = useTracks();
  const toast = useToast();

  const curatorName = (id: string | null) =>
    curators.find((c) => c.id === id)?.name ?? "—";
  const trackTitle = (id: string | null) =>
    tracks.find((t) => t.id === id)?.title ?? "—";

  const stats = useMemo(() => {
    const total = submissions.length;
    const sent = submissions.filter((s) => s.status !== "draft").length;
    const responses = submissions.filter((s) =>
      RESPONDED.includes(s.status),
    ).length;
    const acceptances = submissions.filter((s) => s.status === "accepted").length;
    const rate = sent ? Math.round((responses / sent) * 100) : 0;
    return { total, sent, responses, acceptances, rate };
  }, [submissions]);

  async function setStatus(id: string, status: SubmissionStatus) {
    const { error } = await supabase
      .from("submissions")
      .update({ status })
      .eq("id", id);
    if (error) toast(error.message, "error");
    else refresh();
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Total" value={stats.total} />
        <Stat label="Sent" value={stats.sent} />
        <Stat label="Responses" value={stats.responses} />
        <Stat label="Accepted" value={stats.acceptances} />
        <Stat label="Response rate" value={`${stats.rate}%`} />
      </div>

      {loading ? (
        <p className="py-10 text-center text-muted">Loading…</p>
      ) : submissions.length === 0 ? (
        <div className="card p-8 text-center text-muted">
          No submissions yet. Head to{" "}
          <Link href="/submit" className="text-white underline">
            Submit
          </Link>{" "}
          to pitch a track.
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2.5">Track</th>
                <th className="px-4 py-2.5">Curator</th>
                <th className="px-4 py-2.5">Channel</th>
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s) => (
                <tr key={s.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">{trackTitle(s.track_id)}</td>
                  <td className="px-4 py-2.5">
                    {s.curator_id ? (
                      <Link
                        href={`/curators/${s.curator_id}`}
                        className="hover:underline"
                      >
                        {curatorName(s.curator_id)}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="chip">{s.channel}</span>
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {s.sent_at
                      ? new Date(s.sent_at).toLocaleDateString()
                      : new Date(s.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2.5">
                    <select
                      className="input w-auto py-1 text-xs"
                      value={s.status}
                      onChange={(e) =>
                        setStatus(s.id, e.target.value as SubmissionStatus)
                      }
                    >
                      {SUBMISSION_STATUSES.map((st) => (
                        <option key={st} value={st}>
                          {st}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
