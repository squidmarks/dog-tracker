const api = process.env.API_URL ?? "http://localhost:4000";
export default {
  // Next's gzip buffers the /api/stream event stream (browsers and Caddy both ask for gzip), which silently
  // kills live updates. Compression, if wanted, belongs in the proxy in front.
  compress: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
};
