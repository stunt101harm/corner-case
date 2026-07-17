import type { Config } from "tailwindcss";

/**
 * Dark pitch-green theme: near-black greens for surfaces, chalk white for
 * text, a single vivid turf green as the accent. Card/pitch colors are custom
 * so every component speaks the same palette.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        pitch: {
          950: "#04100A",
          900: "#071A10",
          800: "#0B2517",
          700: "#12341F",
          600: "#1A472C",
          500: "#245C39",
        },
        turf: {
          300: "#7CF0AE",
          400: "#4AE68F",
          500: "#2EE07C",
          600: "#1FBF66",
          700: "#178F4D",
        },
        chalk: "#E9F5EC",
        card: {
          yellow: "#F5C842",
          red: "#F0564A",
        },
      },
      fontFamily: {
        // System stacks: no font downloads at build time, still crisp.
        sans: [
          "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Inter", "Roboto",
          "Helvetica Neue", "Arial", "sans-serif",
        ],
        mono: ["SF Mono", "ui-monospace", "Menlo", "Monaco", "Consolas", "monospace"],
      },
      boxShadow: {
        glow: "0 0 24px rgba(46, 224, 124, 0.12)",
      },
    },
  },
  plugins: [],
};

export default config;
