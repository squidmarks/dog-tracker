/** The app icon artwork: a blue paw print on a white background. Sizes are fractions of the square so one
 *  component renders the favicon, the 512px manifest icon and the 180px iOS Home Screen icon. */
export function PawArt({ size }: { size: number }) {
  const s = (f: number) => Math.round(size * f);
  const ink = "#2a7fa8";
  const toe = (left: number, top: number, rotate: number) => ({
    position: "absolute" as const, left: s(left), top: s(top), width: s(0.15), height: s(0.21),
    borderRadius: size, background: ink, transform: `rotate(${rotate}deg)`,
  });
  return (
    <div style={{ width: size, height: size, display: "flex", position: "relative", background: "#ffffff" }}>
      <div style={toe(0.12, 0.40, -25)} />
      <div style={toe(0.30, 0.20, -8)} />
      <div style={toe(0.55, 0.20, 8)} />
      <div style={toe(0.73, 0.40, 25)} />
      <div style={{ position: "absolute", left: s(0.27), top: s(0.50), width: s(0.46), height: s(0.34), borderRadius: size, background: ink }} />
    </div>
  );
}
