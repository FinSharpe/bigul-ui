/** @type {import('next').NextConfig} */
const nextConfig = {
  // Loaded with Node's require, as in tests, not bundled: undici carries the
  // Bigul partner API calls through the outbound relays (src/lib/auth).
  serverExternalPackages: ["undici"],
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
