"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ConfidenceBadge } from "@/components/ConfidenceBadge";
import { FilterBar } from "@/components/FilterBar";
import { Modal } from "@/components/Modal";
import { CuratorForm } from "@/components/CuratorForm";
import { useToast } from "@/components/Toaster";
import { supabase, useCurators, useUserId } from "@/lib/hooks";
import { EMPTY_FILTERS, allGenres, applyFilters } from "@/lib/filter";
import {
  EXAMPLE_CSV,
  curatorsToCsv,
  parseCuratorCsv,
  type CuratorInsert,
} from "@/lib/csv";
import type { Curator } from "@/lib/types";

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function DirectoryPage() {
  const { curators, loading, refresh } = useCurators();
  const userId = useUserId();
  const toast = useToast();
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Curator | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const genres = useMemo(() => allGenres(curators), [curators]);
  const filtered = useMemo(
    () => applyFilters(curators, filters),
    [curators, filters],
  );

  async function addCurator(data: CuratorInsert & { notes: string | null }) {
    const { error } = await supabase
      .from("curators")
      .insert({ ...data, user_id: userId });
    if (error) toast(error.message, "error");
    else {
      toast("Curator added.");
      setAdding(false);
      refresh();
    }
  }

  async function saveEdit(data: CuratorInsert & { notes: string | null }) {
    if (!editing) return;
    const { error } = await supabase
      .from("curators")
      .update(data)
      .eq("id", editing.id);
    if (error) toast(error.message, "error");
    else {
      toast("Saved.");
      setEditing(null);
      refresh();
    }
  }

  async function deleteCurator(c: Curator) {
    if (!confirm(`Delete "${c.name}"? This only removes your own entry.`)) return;
    const { error } = await supabase.from("curators").delete().eq("id", c.id);
    if (error) toast(error.message, "error");
    else {
      toast("Deleted.");
      refresh();
    }
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const { rows, errors } = parseCuratorCsv(text);
    if (rows.length === 0) {
      toast(errors[0] ?? "No valid rows found.", "error");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    const payload = rows.map((r) => ({ ...r, user_id: userId }));
    const { error } = await supabase.from("curators").insert(payload);
    if (error) toast(error.message, "error");
    else {
      const skipped = errors.length ? ` (${errors.length} skipped)` : "";
      toast(`Imported ${rows.length} curators${skipped}.`, errors.length ? "warn" : "ok");
      refresh();
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Curator directory
          </h1>
          <p className="text-sm text-muted">
            Browse, filter, then head to{" "}
            <Link href="/submit" className="text-white underline">
              Submit
            </Link>{" "}
            to pitch a track.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setAdding(true)} className="btn-primary">
            + Add curator
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className="btn-ghost"
          >
            Import CSV
          </button>
          <button
            onClick={() => download("submitbase-curators.csv", curatorsToCsv(curators))}
            className="btn-ghost"
          >
            Export CSV
          </button>
          <button
            onClick={() => download("submitbase-example.csv", EXAMPLE_CSV)}
            className="btn-ghost"
          >
            Example CSV
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={onImportFile}
          />
        </div>
      </div>

      <FilterBar
        filters={filters}
        setFilters={setFilters}
        genres={genres}
        resultCount={filtered.length}
      />

      {loading ? (
        <p className="py-10 text-center text-muted">Loading directory…</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => {
            const owned = !!c.user_id && c.user_id === userId;
            return (
              <div
                key={c.id}
                className="card flex flex-wrap items-center gap-x-4 gap-y-2 p-4"
              >
                <div className="min-w-[180px] flex-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/curators/${c.id}`}
                      className="font-medium hover:underline"
                    >
                      {c.name}
                    </Link>
                    {owned && <span className="chip">yours</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <span className="chip">{c.type}</span>
                    <span>·</span>
                    <span>{c.contact_method}</span>
                    {c.platform && (
                      <>
                        <span>·</span>
                        <span>{c.platform}</span>
                      </>
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {(c.genres ?? []).map((g) => (
                      <span key={g} className="chip">
                        {g}
                      </span>
                    ))}
                  </div>
                </div>
                <ConfidenceBadge
                  confidence={c.confidence}
                  sourceUrl={c.source_url}
                />
                <div className="flex gap-1.5">
                  <Link href={`/curators/${c.id}`} className="btn-ghost btn-sm">
                    Details
                  </Link>
                  {owned && (
                    <>
                      <button
                        onClick={() => setEditing(c)}
                        className="btn-ghost btn-sm"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteCurator(c)}
                        className="btn-ghost btn-sm text-accent"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <p className="py-10 text-center text-muted">
              No curators match these filters.
            </p>
          )}
        </div>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} title="Add curator">
        <CuratorForm onSubmit={addCurator} onCancel={() => setAdding(false)} />
      </Modal>
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Edit curator"
      >
        {editing && (
          <CuratorForm
            existing={editing}
            onSubmit={saveEdit}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>
    </div>
  );
}
