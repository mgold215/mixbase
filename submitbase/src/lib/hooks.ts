"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Curator, Submission, Track } from "@/lib/types";

// One shared browser client instance for all hooks/components.
const supabase = createClient();
export { supabase };

export function useUserId() {
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    // setState lives inside the async callback (not the effect body).
    supabase.auth
      .getUser()
      .then(({ data }) => active && setUserId(data.user?.id ?? null));
    return () => {
      active = false;
    };
  }, []);
  return userId;
}

export function useCurators() {
  const [curators, setCurators] = useState<Curator[]>([]);
  const [loading, setLoading] = useState(true);

  // Manual refetch, called from event handlers (add/edit/delete/import).
  const refresh = useCallback(
    () =>
      supabase
        .from("curators")
        .select("*")
        .order("name")
        .then(({ data }) => setCurators((data as Curator[]) ?? [])),
    [],
  );

  useEffect(() => {
    let active = true;
    supabase
      .from("curators")
      .select("*")
      .order("name")
      .then(({ data }) => {
        if (!active) return;
        setCurators((data as Curator[]) ?? []);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return { curators, loading, refresh };
}

export function useTracks() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(
    () =>
      supabase
        .from("tracks")
        .select("*")
        .order("created_at", { ascending: false })
        .then(({ data }) => setTracks((data as Track[]) ?? [])),
    [],
  );

  useEffect(() => {
    let active = true;
    supabase
      .from("tracks")
      .select("*")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (!active) return;
        setTracks((data as Track[]) ?? []);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return { tracks, loading, refresh };
}

export function useSubmissions() {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(
    () =>
      supabase
        .from("submissions")
        .select("*")
        .order("created_at", { ascending: false })
        .then(({ data }) => setSubmissions((data as Submission[]) ?? [])),
    [],
  );

  useEffect(() => {
    let active = true;
    supabase
      .from("submissions")
      .select("*")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (!active) return;
        setSubmissions((data as Submission[]) ?? []);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return { submissions, loading, refresh };
}
