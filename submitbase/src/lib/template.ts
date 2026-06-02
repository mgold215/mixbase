import type { Curator, Track } from "./types";

// The default, user-editable message template (see section 8).
// Stored in localStorage so the owner can tweak it on the Settings page.
export const DEFAULT_TEMPLATE = `Subject: {track_title} — submission for {curator_name}

Hi {curator_name},

I'm moodmixformat, a {genre} producer. I think my new track
"{track_title}" could be a strong fit for {curator_name}.

Listen (private, download enabled): {track_url}

{pitch}

Thanks for taking a look — totally understand if it's not the right fit.
— Matt (moodmixformat)`;

const TEMPLATE_KEY = "submitbase:template";

export function loadTemplate(): string {
  if (typeof window === "undefined") return DEFAULT_TEMPLATE;
  return localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE;
}

export function saveTemplate(value: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(TEMPLATE_KEY, value);
}

export function resetTemplate() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TEMPLATE_KEY);
}

// Fill the merge fields for one curator + track.
// Supported: {curator_name} {track_title} {genre} {pitch} {track_url} {platform}
export function renderTemplate(
  template: string,
  curator: Curator,
  track: Track,
): string {
  const fields: Record<string, string> = {
    curator_name: curator.name || "",
    track_title: track.title || "",
    genre: track.genre || (curator.genres?.[0] ?? "electronic"),
    pitch: track.pitch || "",
    track_url: track.track_url || "",
    platform: curator.platform || "",
  };

  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in fields ? fields[key] : whole,
  );
}

// Split a rendered message into a `Subject:` line + body. If no Subject line
// is present, fall back to a sensible default subject.
export function splitSubjectBody(rendered: string): {
  subject: string;
  body: string;
} {
  const lines = rendered.split("\n");
  if (lines[0]?.toLowerCase().startsWith("subject:")) {
    const subject = lines[0].slice("subject:".length).trim();
    // Drop the subject line and any blank line right after it.
    let rest = lines.slice(1);
    if (rest[0]?.trim() === "") rest = rest.slice(1);
    return { subject, body: rest.join("\n") };
  }
  return { subject: "Music submission", body: rendered };
}
