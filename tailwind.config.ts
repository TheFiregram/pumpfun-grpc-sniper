import type { Config } from "tailwindcss";
const config: Config = { content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"], theme: { extend: { colors: { hawk: { bg: "#070d09", panel: "#0d1911", panel2: "#102317", line: "#1d3b28", green: "#20d46b", muted: "#87a18f" } } } }, plugins: [] };
export default config;