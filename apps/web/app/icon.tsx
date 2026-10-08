import { ImageResponse } from "next/og";
import { PawArt } from "./icon-art";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

// Favicon and the manifest icon (served at /icon).
export default function Icon() {
  return new ImageResponse(<PawArt size={512} />, size);
}
