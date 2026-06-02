"use client";

import { useState } from "react";
import type {
  Confidence,
  ContactMethod,
  Curator,
  CuratorType,
} from "@/lib/types";
import type { CuratorInsert } from "@/lib/csv";

const TYPES: CuratorType[] = [
  "label",
  "playlist",
  "blog",
  "radio",
  "influencer",
  "other",
];
const METHODS: ContactMethod[] = [
  "form",
  "email",
  "soundcloud",
  "instagram",
  "twitter",
  "other",
];

// Add/edit form for the user's OWN curators. `existing` = edit mode.
export function CuratorForm({
  existing,
  onSubmit,
  onCancel,
}: {
  existing?: Curator;
  onSubmit: (data: CuratorInsert & { notes: string | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [type, setType] = useState<CuratorType>(existing?.type ?? "label");
  const [platform, setPlatform] = useState(existing?.platform ?? "");
  const [genres, setGenres] = useState((existing?.genres ?? []).join(", "));
  const [method, setMethod] = useState<ContactMethod>(
    existing?.contact_method ?? "form",
  );
  const [contactValue, setContactValue] = useState(
    existing?.contact_value ?? "",
  );
  const [audience, setAudience] = useState(
    existing?.audience_size != null ? String(existing.audience_size) : "",
  );
  const [guidelines, setGuidelines] = useState(existing?.guidelines ?? "");
  const [confidence, setConfidence] = useState<Confidence>(
    existing?.confidence ?? "VERIFIED",
  );
  const [sourceUrl, setSourceUrl] = useState(existing?.source_url ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        type,
        platform: platform.trim() || null,
        genres: genres
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean),
        contact_method: method,
        contact_value: contactValue.trim() || null,
        audience_size: audience ? Number(audience) : null,
        accepts_submissions: true,
        guidelines: guidelines.trim() || null,
        confidence,
        source_url: sourceUrl.trim() || null,
        notes: notes.trim() || null,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="label">Name *</label>
        <input
          required
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Type</label>
          <select
            className="input"
            value={type}
            onChange={(e) => setType(e.target.value as CuratorType)}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Platform</label>
          <input
            className="input"
            placeholder="web, SoundCloud, LabelRadar…"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          />
        </div>
      </div>
      <div>
        <label className="label">Genres (comma-separated)</label>
        <input
          className="input"
          placeholder="house, tech house, deep house"
          value={genres}
          onChange={(e) => setGenres(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Contact method</label>
          <select
            className="input"
            value={method}
            onChange={(e) => setMethod(e.target.value as ContactMethod)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Audience size</label>
          <input
            className="input"
            type="number"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
          />
        </div>
      </div>
      <div>
        <label className="label">Contact value (email or URL/handle)</label>
        <input
          className="input"
          placeholder="demos@label.com  or  https://label.com/demos"
          value={contactValue}
          onChange={(e) => setContactValue(e.target.value)}
        />
      </div>
      <div>
        <label className="label">Guidelines</label>
        <textarea
          className="input min-h-[64px]"
          value={guidelines}
          onChange={(e) => setGuidelines(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Confidence</label>
          <select
            className="input"
            value={confidence}
            onChange={(e) => setConfidence(e.target.value as Confidence)}
          >
            <option value="VERIFIED">VERIFIED</option>
            <option value="UNVERIFIED">UNVERIFIED</option>
          </select>
        </div>
        <div>
          <label className="label">Source URL</label>
          <input
            className="input"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
          />
        </div>
      </div>
      <div>
        <label className="label">Private notes</label>
        <textarea
          className="input min-h-[48px]"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="btn-ghost">
          Cancel
        </button>
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? "Saving…" : existing ? "Save changes" : "Add curator"}
        </button>
      </div>
    </form>
  );
}
