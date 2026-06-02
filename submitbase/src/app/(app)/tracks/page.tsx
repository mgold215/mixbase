"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toaster";
import { supabase, useTracks } from "@/lib/hooks";
import { ARTIST_NAME } from "@/lib/config";
import type { Track } from "@/lib/types";

type Draft = {
  title: string;
  genre: string;
  track_url: string;
  artwork_url: string;
  pitch: string;
};

const EMPTY: Draft = {
  title: "",
  genre: "",
  track_url: "",
  artwork_url: "",
  pitch: "",
};

export default function TracksPage() {
  const { tracks, loading, refresh } = useTracks();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Track | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);

  function startAdd() {
    setEditing(null);
    setDraft(EMPTY);
    setOpen(true);
  }
  function startEdit(t: Track) {
    setEditing(t);
    setDraft({
      title: t.title,
      genre: t.genre ?? "",
      track_url: t.track_url ?? "",
      artwork_url: t.artwork_url ?? "",
      pitch: t.pitch ?? "",
    });
    setOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const payload = {
      title: draft.title.trim(),
      artist: ARTIST_NAME,
      genre: draft.genre.trim() || null,
      track_url: draft.track_url.trim() || null,
      artwork_url: draft.artwork_url.trim() || null,
      pitch: draft.pitch.trim() || null,
    };
    const { error } = editing
      ? await supabase.from("tracks").update(payload).eq("id", editing.id)
      : await supabase.from("tracks").insert(payload);
    setSaving(false);
    if (error) toast(error.message, "error");
    else {
      toast(editing ? "Track saved." : "Track added.");
      setOpen(false);
      refresh();
    }
  }

  async function remove(t: Track) {
    if (!confirm(`Delete "${t.title}"? Its submissions will also be removed.`))
      return;
    const { error } = await supabase.from("tracks").delete().eq("id", t.id);
    if (error) toast(error.message, "error");
    else {
      toast("Deleted.");
      refresh();
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your tracks</h1>
          <p className="text-sm text-muted">
            Add a track here, then pitch it from the Submit page.
          </p>
        </div>
        <button onClick={startAdd} className="btn-primary">
          + Add track
        </button>
      </div>

      {loading ? (
        <p className="py-10 text-center text-muted">Loading…</p>
      ) : tracks.length === 0 ? (
        <div className="card p-8 text-center text-muted">
          No tracks yet. Add your first release to get started.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {tracks.map((t) => (
            <div key={t.id} className="card p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-medium">{t.title}</h3>
                  <p className="text-xs text-muted">{t.genre || "no genre"}</p>
                </div>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => startEdit(t)}
                    className="btn-ghost btn-sm"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => remove(t)}
                    className="btn-ghost btn-sm text-accent"
                  >
                    Delete
                  </button>
                </div>
              </div>
              {t.track_url && (
                <a
                  href={t.track_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 block break-all text-xs text-white underline"
                >
                  {t.track_url}
                </a>
              )}
              {t.pitch && (
                <p className="mt-2 line-clamp-3 text-sm text-muted">{t.pitch}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit track" : "Add track"}
      >
        <form onSubmit={save} className="space-y-3">
          <div>
            <label className="label">Title *</label>
            <input
              required
              className="input"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Genre</label>
            <input
              className="input"
              placeholder="melodic house"
              value={draft.genre}
              onChange={(e) => setDraft({ ...draft, genre: e.target.value })}
            />
          </div>
          <div>
            <label className="label">
              Listening link (private, download-enabled SoundCloud)
            </label>
            <input
              className="input"
              placeholder="https://soundcloud.com/you/track/s-xxxx"
              value={draft.track_url}
              onChange={(e) =>
                setDraft({ ...draft, track_url: e.target.value })
              }
            />
          </div>
          <div>
            <label className="label">Artwork URL (optional)</label>
            <input
              className="input"
              value={draft.artwork_url}
              onChange={(e) =>
                setDraft({ ...draft, artwork_url: e.target.value })
              }
            />
          </div>
          <div>
            <label className="label">Reusable pitch</label>
            <textarea
              className="input min-h-[90px]"
              placeholder="A 2-3 sentence description of the track and why it fits."
              value={draft.pitch}
              onChange={(e) => setDraft({ ...draft, pitch: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="btn-ghost"
            >
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
