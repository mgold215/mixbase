import { NextResponse } from "next/server";
import { BATCH_SEND_CAP, BATCH_SEND_DELAY_MS } from "@/lib/config";

// ─── Mode B: optional batch email via Resend ───
// Active only when RESEND_API_KEY + SUBMIT_FROM_EMAIL are set.

const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.SUBMIT_FROM_EMAIL;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// GET → lets the client know whether the batch button should be shown.
export async function GET() {
  return NextResponse.json({ enabled: !!(RESEND_KEY && FROM) });
}

type Item = { curatorId: string; to: string; subject: string; body: string };

export async function POST(request: Request) {
  if (!RESEND_KEY || !FROM) {
    return NextResponse.json(
      { error: "Batch email is not configured (set RESEND_API_KEY + SUBMIT_FROM_EMAIL)." },
      { status: 501 },
    );
  }

  let items: Item[] = [];
  try {
    const body = await request.json();
    items = Array.isArray(body.items) ? body.items : [];
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Enforce the per-run cap as a safety rail.
  items = items.slice(0, BATCH_SEND_CAP);

  const results: { curatorId: string; ok: boolean; error?: string }[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // Pause between sends (skip before the first) to stay polite + under limits.
    if (i > 0) await sleep(BATCH_SEND_DELAY_MS);

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM,
          to: item.to,
          subject: item.subject,
          text: item.body,
        }),
      });
      if (res.ok) {
        results.push({ curatorId: item.curatorId, ok: true });
      } else {
        const err = await res.text();
        results.push({ curatorId: item.curatorId, ok: false, error: err });
      }
    } catch (e) {
      results.push({
        curatorId: item.curatorId,
        ok: false,
        error: e instanceof Error ? e.message : "send failed",
      });
    }
  }

  return NextResponse.json({ results });
}
