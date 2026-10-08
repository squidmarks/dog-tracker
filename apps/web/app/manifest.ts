import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Dog Tracker",
    short_name: "Dogs",
    description: "Live GPS tracking for the dogs",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#2e86ab",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
