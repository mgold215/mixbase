"use client";

import type { ContactMethod, CuratorType } from "@/lib/types";
import type { FilterState, SortKey } from "@/lib/filter";

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

function toggle<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value];
}

export function FilterBar({
  filters,
  setFilters,
  genres,
  resultCount,
}: {
  filters: FilterState;
  setFilters: (f: FilterState) => void;
  genres: string[];
  resultCount: number;
}) {
  const Pill = ({
    active,
    onClick,
    children,
  }: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
  }) => (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
        active
          ? "border-accent bg-accent-dim text-white"
          : "border-border bg-surface-2 text-muted hover:text-white"
      }`}
    >
      {children}
    </button>
  );

  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="input flex-1 min-w-[180px]"
          placeholder="Search by name…"
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
        />
        <select
          className="input w-auto"
          value={filters.confidence}
          onChange={(e) =>
            setFilters({
              ...filters,
              confidence: e.target.value as FilterState["confidence"],
            })
          }
        >
          <option value="all">All confidence</option>
          <option value="VERIFIED">Verified only</option>
          <option value="UNVERIFIED">Unverified only</option>
        </select>
        <select
          className="input w-auto"
          value={filters.sort}
          onChange={(e) =>
            setFilters({ ...filters, sort: e.target.value as SortKey })
          }
        >
          <option value="name">Sort: Name</option>
          <option value="type">Sort: Type</option>
        </select>
        <span className="text-xs text-muted">{resultCount} curators</span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs uppercase tracking-wide text-muted">
          Type
        </span>
        {TYPES.map((t) => (
          <Pill
            key={t}
            active={filters.types.includes(t)}
            onClick={() =>
              setFilters({ ...filters, types: toggle(filters.types, t) })
            }
          >
            {t}
          </Pill>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs uppercase tracking-wide text-muted">
          Channel
        </span>
        {METHODS.map((m) => (
          <Pill
            key={m}
            active={filters.methods.includes(m)}
            onClick={() =>
              setFilters({ ...filters, methods: toggle(filters.methods, m) })
            }
          >
            {m}
          </Pill>
        ))}
      </div>

      {genres.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs uppercase tracking-wide text-muted">
            Genre
          </span>
          {genres.map((g) => (
            <Pill
              key={g}
              active={filters.genres.includes(g)}
              onClick={() =>
                setFilters({ ...filters, genres: toggle(filters.genres, g) })
              }
            >
              {g}
            </Pill>
          ))}
        </div>
      )}
    </div>
  );
}
