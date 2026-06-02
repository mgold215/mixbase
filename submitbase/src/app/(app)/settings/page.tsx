"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/components/Toaster";
import {
  DEFAULT_TEMPLATE,
  loadTemplate,
  resetTemplate,
  saveTemplate,
} from "@/lib/template";

const FIELDS = [
  "{curator_name}",
  "{track_title}",
  "{genre}",
  "{pitch}",
  "{track_url}",
  "{platform}",
];

export default function SettingsPage() {
  const toast = useToast();
  const [template, setTemplate] = useState("");

  useEffect(() => {
    // Read the saved template once on mount (client-only localStorage).
    // Deferred to a microtask so it isn't a synchronous setState in the effect.
    Promise.resolve().then(() => setTemplate(loadTemplate()));
  }, []);

  function save() {
    saveTemplate(template);
    toast("Template saved.");
  }
  function reset() {
    resetTemplate();
    setTemplate(DEFAULT_TEMPLATE);
    toast("Reset to default template.");
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <div className="card p-5">
        <h2 className="font-medium">Message template</h2>
        <p className="mt-1 text-sm text-muted">
          This is the default pitch generated for each curator. Keep the first
          line as <code className="text-white">Subject:</code> so email
          subjects are filled in automatically. You can still edit every message
          individually before sending.
        </p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {FIELDS.map((f) => (
            <code key={f} className="chip text-white">
              {f}
            </code>
          ))}
        </div>

        <textarea
          className="input mt-3 min-h-[280px] font-mono text-xs"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
        />

        <div className="mt-3 flex gap-2">
          <button onClick={save} className="btn-primary">
            Save template
          </button>
          <button onClick={reset} className="btn-ghost">
            Reset to default
          </button>
        </div>
      </div>

      <div className="card p-5 text-sm text-muted">
        <h2 className="font-medium text-white">Email modes</h2>
        <p className="mt-2">
          <span className="text-white">Mode A (default):</span> clicking an
          email curator opens a pre-filled message in your own mail app — zero
          setup, you stay in control.
        </p>
        <p className="mt-2">
          <span className="text-white">Mode B (optional):</span> set{" "}
          <code className="text-white">RESEND_API_KEY</code> and{" "}
          <code className="text-white">SUBMIT_FROM_EMAIL</code> in{" "}
          <code className="text-white">.env.local</code> to enable a
          “Batch-send emails” button on the review screen (max 20 per run, 3s
          apart).
        </p>
      </div>
    </div>
  );
}
