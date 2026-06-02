import type { Confidence, ContactMethod, Curator, CuratorType } from "./types";

export type SortKey = "name" | "type";

export interface FilterState {
  search: string;
  genres: string[]; // multi-select (curator matches if it has ANY selected genre)
  types: CuratorType[];
  methods: ContactMethod[];
  confidence: Confidence | "all";
  sort: SortKey;
}

export const EMPTY_FILTERS: FilterState = {
  search: "",
  genres: [],
  types: [],
  methods: [],
  confidence: "all",
  sort: "name",
};

// Unique, sorted genre list across the whole directory (for the genre filter).
export function allGenres(curators: Curator[]): string[] {
  const set = new Set<string>();
  for (const c of curators) for (const g of c.genres ?? []) set.add(g);
  return Array.from(set).sort();
}

export function applyFilters(
  curators: Curator[],
  f: FilterState,
): Curator[] {
  const q = f.search.trim().toLowerCase();
  const filtered = curators.filter((c) => {
    if (q && !c.name.toLowerCase().includes(q)) return false;
    if (f.types.length && !(c.type && f.types.includes(c.type))) return false;
    if (
      f.methods.length &&
      !(c.contact_method && f.methods.includes(c.contact_method))
    )
      return false;
    if (f.confidence !== "all" && c.confidence !== f.confidence) return false;
    if (f.genres.length) {
      const cg = c.genres ?? [];
      if (!f.genres.some((g) => cg.includes(g))) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (f.sort === "type") {
      const t = (a.type ?? "").localeCompare(b.type ?? "");
      if (t !== 0) return t;
    }
    return a.name.localeCompare(b.name);
  });

  return filtered;
}
