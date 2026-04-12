"use client";

import { useEffect } from "react";

// Registers the service worker for PWA support.
// Placed in layout so it runs on every page load.
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.log("SW registration failed:", err);
      });
    }
  }, []);

  return null;
}
