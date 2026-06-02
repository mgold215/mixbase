import type { Curator, SubmissionChannel } from "./types";

export const SPOTIFY_EDITORIAL_URL = "https://artists.spotify.com";

export function isSpotifyEditorial(curator: Curator): boolean {
  return (curator.contact_value ?? "").trim() === SPOTIFY_EDITORIAL_URL;
}

function looksLikeEmail(value: string): boolean {
  return value.includes("@") && !value.includes("://");
}

// How a given curator will actually be contacted, branching by contact_method
// (see section 9). Returns the action "kind" + the resulting submission channel.
export type SendKind = "email" | "form" | "social" | "spotify";

export function resolveSend(curator: Curator): {
  kind: SendKind;
  channel: SubmissionChannel;
} {
  if (isSpotifyEditorial(curator)) return { kind: "spotify", channel: "spotify" };

  switch (curator.contact_method) {
    case "email":
      return { kind: "email", channel: "email" };
    case "form":
      return { kind: "form", channel: "form" };
    case "instagram":
    case "twitter":
    case "soundcloud":
      return { kind: "social", channel: "social" };
    case "other":
    default: {
      const v = curator.contact_value ?? "";
      return looksLikeEmail(v)
        ? { kind: "email", channel: "email" }
        : { kind: "form", channel: "form" };
    }
  }
}

// The primary button label shown for each curator in the review step.
export function actionLabel(curator: Curator): string {
  const { kind } = resolveSend(curator);
  switch (kind) {
    case "email":
      return "Open email";
    case "form":
      return "Copy pitch & open form";
    case "social":
      return "Copy message & open profile";
    case "spotify":
      return "Open Spotify for Artists";
  }
}

export function buildMailto(to: string, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(body)}`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  // Legacy fallback for non-secure contexts.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
