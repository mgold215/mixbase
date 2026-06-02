import type { Config } from "tailwindcss";

// Apple Music-inspired dark palette: near-black surfaces, a single warm accent.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0a0a0b", // page background
        surface: "#161618", // cards, rows
        "surface-2": "#1e1e21", // hover / inputs
        border: "#2a2a2e",
        muted: "#8a8a8f",
        accent: "#fa2d48", // Apple Music red — used sparingly
        "accent-dim": "#3a1820",
        ok: "#34c759", // VERIFIED green
        "ok-dim": "#14301d",
        warn: "#ffb020", // UNVERIFIED amber
        "warn-dim": "#3a2c12",
      },
      borderRadius: {
        xl: "14px",
        "2xl": "18px",
      },
    },
  },
  plugins: [],
};

export default config;
