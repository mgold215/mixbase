import { Nav } from "@/components/Nav";
import { Toaster } from "@/components/Toaster";

// Layout for all signed-in pages (middleware guarantees a logged-in user here).
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Toaster>
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </Toaster>
  );
}
