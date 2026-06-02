// TypeScript shapes mirroring the tables in schema.sql.

export type CuratorType =
  | "playlist"
  | "label"
  | "blog"
  | "radio"
  | "influencer"
  | "other";

export type ContactMethod =
  | "email"
  | "instagram"
  | "twitter"
  | "soundcloud"
  | "form"
  | "other";

export type Confidence = "VERIFIED" | "UNVERIFIED";

export type SubmissionChannel = "email" | "form" | "social" | "spotify";

export type SubmissionStatus =
  | "draft"
  | "sent"
  | "opened"
  | "responded"
  | "accepted"
  | "rejected"
  | "no_response";

export interface Curator {
  id: string;
  user_id: string | null; // null = shared starter directory
  name: string;
  type: CuratorType | null;
  platform: string | null;
  genres: string[] | null;
  contact_method: ContactMethod | null;
  contact_value: string | null;
  audience_size: number | null;
  accepts_submissions: boolean;
  guidelines: string | null;
  confidence: Confidence;
  source_url: string | null;
  notes: string | null;
  last_contacted: string | null;
  created_at: string;
}

export interface Track {
  id: string;
  user_id: string;
  title: string;
  artist: string | null;
  genre: string | null;
  track_url: string | null;
  artwork_url: string | null;
  pitch: string | null;
  created_at: string;
}

export interface Submission {
  id: string;
  user_id: string;
  track_id: string | null;
  curator_id: string | null;
  channel: SubmissionChannel | null;
  message: string | null;
  status: SubmissionStatus;
  response_notes: string | null;
  sent_at: string | null;
  created_at: string;
}

// All submission statuses, in pipeline order (used by the dashboard).
export const SUBMISSION_STATUSES: SubmissionStatus[] = [
  "draft",
  "sent",
  "opened",
  "responded",
  "accepted",
  "rejected",
  "no_response",
];
