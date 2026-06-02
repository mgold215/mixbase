// ─── App-wide constants ───
// Change the app name in ONE place here.
export const APP_NAME = "SubmitBase";

// The artist this hub belongs to (used as a default + in the message template).
export const ARTIST_NAME = "moodmixformat";

// Mode B safety rails (batch email via Resend).
export const BATCH_SEND_CAP = 20; // max emails sent per run
export const BATCH_SEND_DELAY_MS = 3000; // pause between sends (3s)
