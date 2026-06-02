"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { APP_NAME } from "@/lib/config";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [error, setError] = useState("");

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError("");
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) {
      setError(error.message);
      setStatus("error");
    } else {
      setStatus("sent");
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="card w-full max-w-sm p-7">
        <h1 className="text-2xl font-semibold tracking-tight">{APP_NAME}</h1>
        <p className="mt-1 text-sm text-muted">
          Your personal music submission hub. Sign in with a magic link — no
          password needed.
        </p>

        {status === "sent" ? (
          <div className="mt-6 rounded-xl border border-ok bg-ok-dim p-4 text-sm text-ok">
            Check <span className="font-medium">{email}</span> for your sign-in
            link. Open it on this device.
          </div>
        ) : (
          <form onSubmit={sendMagicLink} className="mt-6 space-y-3">
            <div>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoFocus
                className="input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <button
              type="submit"
              disabled={status === "sending"}
              className="btn-primary w-full"
            >
              {status === "sending" ? "Sending…" : "Send magic link"}
            </button>
            {status === "error" && (
              <p className="text-sm text-accent">{error}</p>
            )}
          </form>
        )}
      </div>
    </main>
  );
}
