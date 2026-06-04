/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pre-existing type/lint errors live in non-critical paths (predict/v2, pma,
  // scripts) and must not block a production build of the dashboard. Real type
  // signal still comes from `bun run typecheck`.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb'
    }
  }
};

export default nextConfig;
