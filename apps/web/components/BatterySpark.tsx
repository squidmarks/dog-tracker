"use client";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { batteryHoursLeft } from "../lib/units";
import type { TelemetryPoint } from "../lib/types";

/** A 24-hour battery trend with a runtime estimate (once the drain is clear). */
export function BatterySpark({ dogId }: { dogId: string }) {
  const [pts, setPts] = useState<TelemetryPoint[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => api.telemetry(dogId, 24).then((p) => alive && setPts(p.filter((x) => x.battery != null))).catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [dogId]);

  if (pts.length < 2) return null;
  const W = 96, H = 22;
  const t0 = pts[0].ts, span = Math.max(1, pts[pts.length - 1].ts - t0);
  const line = pts.map((p) => `${(((p.ts - t0) / span) * W).toFixed(1)},${(H - (Math.min(100, p.battery!) / 100) * H).toFixed(1)}`).join(" ");
  const hours = batteryHoursLeft(pts.slice(-24));
  return (
    <div className="spark" title="Battery over the last 24 hours">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden><polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
      {hours != null && <span>≈ {hours >= 48 ? `${Math.round(hours / 24)} days` : `${Math.round(hours)} h`} left</span>}
    </div>
  );
}
