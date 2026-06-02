"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { APP_NAME } from "@/lib/config";

const LINKS = [
  { href: "/", label: "Directory" },
  { href: "/submit", label: "Submit" },
  { href: "/tracks", label: "Tracks" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-1 px-4 py-3">
        <Link href="/" className="mr-3 text-base font-semibold tracking-tight">
          {APP_NAME}
        </Link>
        <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
          {LINKS.map((l) => {
            const active =
              l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-lg px-3 py-1.5 text-sm transition ${
                  active
                    ? "bg-surface-2 text-white"
                    : "text-muted hover:text-white"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <button onClick={signOut} className="btn-ghost btn-sm whitespace-nowrap">
          Sign out
        </button>
      </div>
    </header>
  );
}
