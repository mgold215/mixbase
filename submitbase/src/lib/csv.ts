import type {
  Confidence,
  ContactMethod,
  Curator,
  CuratorType,
} from "./types";

// CSV import/export (see section 10).
// Header (confidence + source_url optional on import):
export const CSV_HEADER = [
  "name",
  "type",
  "platform",
  "genres",
  "contact_method",
  "contact_value",
  "audience_size",
  "accepts_submissions",
  "guidelines",
  "confidence",
  "source_url",
] as const;

const VALID_TYPES: CuratorType[] = [
  "playlist",
  "label",
  "blog",
  "radio",
  "influencer",
  "other",
];
const VALID_METHODS: ContactMethod[] = [
  "email",
  "instagram",
  "twitter",
  "soundcloud",
  "form",
  "other",
];

// A new curator row ready to insert (user_id is added by the caller).
export type CuratorInsert = {
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
};

export type ParseResult = {
  rows: CuratorInsert[];
  errors: string[]; // human-readable, one per skipped row
};

// ─── A small, correct CSV parser (handles quotes, commas, newlines) ───
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++; // swallow CRLF
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else {
      field += c;
    }
  }
  // flush trailing field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export function parseCuratorCsv(text: string): ParseResult {
  const grid = parseCsv(text);
  const errors: string[] = [];
  const rows: CuratorInsert[] = [];
  if (grid.length === 0) return { rows, errors: ["File is empty."] };

  // Map header names -> column index (case-insensitive, order-independent).
  const header = grid[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const nameIdx = col("name");
  if (nameIdx === -1) {
    return {
      rows,
      errors: [
        `Missing required "name" column. Expected header: ${CSV_HEADER.join(",")}`,
      ],
    };
  }

  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    const get = (name: string) => {
      const idx = col(name);
      return idx === -1 ? "" : (cells[idx] ?? "").trim();
    };
    const rowNum = r + 1;

    const name = get("name");
    if (!name) {
      errors.push(`Row ${rowNum}: skipped (no name).`);
      continue;
    }

    const typeRaw = get("type").toLowerCase();
    const type = VALID_TYPES.includes(typeRaw as CuratorType)
      ? (typeRaw as CuratorType)
      : typeRaw
        ? "other"
        : null;

    const methodRaw = get("contact_method").toLowerCase();
    const contact_method = VALID_METHODS.includes(methodRaw as ContactMethod)
      ? (methodRaw as ContactMethod)
      : methodRaw
        ? "other"
        : null;

    const genresRaw = get("genres");
    const genres = genresRaw
      ? genresRaw
          .split(";")
          .map((g) => g.trim())
          .filter(Boolean)
      : null;

    const audienceRaw = get("audience_size");
    const audience_size = audienceRaw ? Number(audienceRaw) : null;
    if (audience_size !== null && Number.isNaN(audience_size)) {
      errors.push(`Row ${rowNum}: skipped (audience_size is not a number).`);
      continue;
    }

    const acceptsRaw = get("accepts_submissions").toLowerCase();
    const accepts_submissions = acceptsRaw === "" ? true : acceptsRaw !== "false";

    const confRaw = get("confidence").toUpperCase();
    const confidence: Confidence = confRaw === "UNVERIFIED" ? "UNVERIFIED" : "VERIFIED";

    rows.push({
      name,
      type,
      platform: get("platform") || null,
      genres,
      contact_method,
      contact_value: get("contact_value") || null,
      audience_size,
      accepts_submissions,
      guidelines: get("guidelines") || null,
      confidence,
      source_url: get("source_url") || null,
    });
  }

  return { rows, errors };
}

// ─── Export ───
function escapeCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function curatorsToCsv(curators: Curator[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const c of curators) {
    const cells = [
      c.name ?? "",
      c.type ?? "",
      c.platform ?? "",
      (c.genres ?? []).join(";"),
      c.contact_method ?? "",
      c.contact_value ?? "",
      c.audience_size != null ? String(c.audience_size) : "",
      String(c.accepts_submissions),
      c.guidelines ?? "",
      c.confidence ?? "",
      c.source_url ?? "",
    ];
    lines.push(cells.map((x) => escapeCell(String(x))).join(","));
  }
  return lines.join("\n");
}

// A tiny example file offered for download (2 sample rows, per section 10).
export const EXAMPLE_CSV = `name,type,platform,genres,contact_method,contact_value,audience_size,accepts_submissions,guidelines,confidence,source_url
My Favorite Label,label,web,house;tech house,form,https://example.com/demos,,true,Private SoundCloud links only,VERIFIED,https://example.com/demos
A Tastemaker Blog,blog,web,bass;dubstep,email,demos@exampleblog.com,50000,true,Personalize your email,UNVERIFIED,https://forum.example.com/thread
`;
