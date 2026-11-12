import type { NextConfig } from "next";

const config: NextConfig = {
  // A self-contained server for the Docker image.
  output: "standalone",
  // undici carries the per-server TLS options and ssh2 loads optional native modules at run time: keep both out of the bundle.
  serverExternalPackages: ["undici", "ssh2"],
  poweredByHeader: false,
  // `next dev` prints the arguments of every server action it runs. Some actions take secrets (a variable's value, a
  // password, a private key): never let them reach a log, even in development.
  logging: { serverFunctions: false },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Cache-Control", value: "no-store" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
        ],
      },
    ];
  },
};

export default config;
