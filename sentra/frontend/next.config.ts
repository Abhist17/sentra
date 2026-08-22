import path from "path";
import type { NextConfig } from "next";

// GitHub Pages serves the site from /<repo>, so assets need a base path. Set
// by the deploy workflow; unset for local dev and for host-root deployments
// like Vercel.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // The dashboard is entirely client-rendered — it reads everything from the
  // engine API at runtime — so it exports to static files and can be hosted
  // on any static host, GitHub Pages included.
  output: "export",
  basePath: basePath || undefined,
  // Emits /path/index.html rather than /path.html, which is what static hosts
  // resolve for a directory-style URL.
  trailingSlash: true,
  images: { unoptimized: true },

  // Next 16 writes AGENTS.md / CLAUDE.md into the project on every dev start.
  // This repo documents itself in the root README, so keep it out.
  agentRules: false,

  // This app lives inside the Anchor workspace, which has its own lockfile.
  // Without this Next walks up and picks the wrong workspace root for tracing.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
