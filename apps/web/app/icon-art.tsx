/** The app icon artwork: a white paw print on a blue gradient. Sizes are fractions of the square so one
 *  component renders the favicon, the 512px manifest icon and the 180px iOS Home Screen icon. */
export function PawArt({ size }: { size: number }) {
  const s = (f: number) => Math.round(size * f);
  const white = "#ffffff";
  const toe = (left: number, top: number, rotate: number) => ({
    position: "absolute" as const, left: s(left), top: s(top), width: s(0.15), height: s(0.21),
    borderRadius: size, background: white, transform: `rotate(${rotate}deg)`,
  });
  return (
    <div style={{ width: size, height: size, display: "flex", position: "relative", background: "linear-gradient(135deg, #3aa5cf, #1d6a8c)" }}>
      <div style={toe(0.12, 0.40, -25)} />
      <div style={toe(0.30, 0.20, -8)} />
      <div style={toe(0.55, 0.20, 8)} />
      <div style={toe(0.73, 0.40, 25)} />
      <div style={{ position: "absolute", left: s(0.27), top: s(0.50), width: s(0.46), height: s(0.34), borderRadius: size, background: white }} />
    </div>
  );
}
