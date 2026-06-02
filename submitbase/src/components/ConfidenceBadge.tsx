import type { Confidence } from "@/lib/types";

// VERIFIED → subtle green. UNVERIFIED → amber warning.
export function ConfidenceBadge({
  confidence,
  sourceUrl,
}: {
  confidence: Confidence;
  sourceUrl?: string | null;
}) {
  if (confidence === "UNVERIFIED") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-flex items-center rounded-full bg-warn-dim px-2 py-0.5 text-xs font-medium text-warn">
          ⚠ Unverified
        </span>
        {sourceUrl ? (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-warn underline underline-offset-2 hover:opacity-80"
          >
            confirm source
          </a>
        ) : null}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-ok-dim px-2 py-0.5 text-xs font-medium text-ok">
      ✓ Verified
    </span>
  );
}
