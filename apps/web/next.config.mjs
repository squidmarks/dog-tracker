const api = process.env.API_URL ?? "http://localhost:4000";
export default {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
};
