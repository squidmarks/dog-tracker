import { ImageResponse } from "next/og";
import { PawArt } from "./icon-art";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// The iOS "Add to Home Screen" icon. iOS rounds the corners itself, so the artwork fills the whole square.
export default function AppleIcon() {
  return new ImageResponse(<PawArt size={180} />, size);
}
