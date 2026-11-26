/** @type {import('next').NextConfig} */
const nextConfig = {
  // Loaded with Node's require, as in tests, not bundled: undici carries the
  // Bigul partner API calls through the outbound relays (src/lib/auth).
  serverExternalPackages: ["undici"],
  // Fonts in public/ have no content hash (next/font used to give them one),
  // so cache them for a week and revalidate in the background.
  async headers() {
    return [
      {
        source: "/fonts/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=604800, stale-while-revalidate=86400",
          },
        ],
      },
    ];
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
