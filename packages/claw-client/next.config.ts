import type { NextConfig } from "next";

// `output: "export"` produces a static bundle in `out/` that the openclaw
// plugin serves at /plugins/openclawos. basePath/assetPrefix make the emitted
// HTML reference assets under /plugins/openclawos/* so the plugin route resolves
// them. Set NEXT_OUTPUT=server to disable export (e.g. for `pnpm dev`).
// Set NEXT_BASEPATH="" to force an empty basePath (for standalone ACP serving).
const isStaticExport = process.env["NEXT_OUTPUT"] !== "server";
const basePath = process.env["NEXT_BASEPATH_EMPTY"] === "1" ? "" : "/plugins/openclawos";

const nextConfig: NextConfig = {
  ...(isStaticExport ? { output: "export" as const, basePath, assetPrefix: basePath } : {}),
  reactStrictMode: false,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
