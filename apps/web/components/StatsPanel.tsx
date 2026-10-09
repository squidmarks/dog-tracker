"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatDistance, formatDuration, formatSpeed, type Units } from "../lib/units";
import { resolveRange, type LeaderRow, type RangePreset } from "../lib/types";

type Period = Extract<RangePreset, "today" | "yesterday" | "week">;
const LABEL: Record<Period, string> = { today: "Today", yesterday: "Yesterday", week: "7 days" };

const when = (ts: number, period: Period) =>
  new Date(ts * 1000).toLocaleString([], period === "week"
    ? { weekday: "short", hour: "numeric", minute: "2-digit" } : { hour: "numeric", minute: "2-digit" });

/** Distance, top speed and active time per dog for a day or a week, with the fastest dog marked. */
export function StatsPanel({ units, onTopSpeed }: { units: Units; onTopSpeed: (row: LeaderRow, label: string) => void }) {
  const [period, setPeriod] = useState<Period>("today");
  const [rows, setRows] = useState<LeaderRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { from, to } = resolveRange({ preset: period });
      setRows((await api.stats(from, to)).sort((a, b) => b.stats.distanceM - a.stats.distanceM));
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [period]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const fastest = rows.reduce<LeaderRow | null>((best, r) =>
    r.stats.topSpeed && (!best || r.stats.topSpeed.mps > best.stats.topSpeed!.mps) ? r : best, null);

  return (
    <section>
      <h2>Stats
        <span className="grow" />
        <span className="seg small" role="group" aria-label="Stats period">
          {(Object.keys(LABEL) as Period[]).map((p) => (
            <button key={p} className={period === p ? "on" : ""} onClick={() => setPeriod(p)}>{LABEL[p]}</button>
          ))}
        </span>
      </h2>
      {error && <p className="error">{error}</p>}
      {rows.length === 0 && !error && <p className="meta">Stats appear once a dog has reported.</p>}
      {rows.map((r) => {
        const top = r.stats.topSpeed;
        const lowerBound = !!top && (top.source === "derived" || (r.stats.medianIntervalS ?? 0) > 20);
        return (
          <div key={r.dogId} className="card stat">
            <b>{r.emoji ?? "🐕"} {r.name}{fastest?.dogId === r.dogId && rows.length > 1 && <span title="Fastest today"> 🏆</span>}{r.sim && <span className="badge">sim</span>}</b>
            <div className="statline">
              <span><big>{formatDistance(r.stats.distanceM, units)}</big> travelled</span>
              <span>{formatDuration(r.stats.movingS)} active</span>
            </div>
            {top ? (
              <button className="link topspeed" onClick={() => onTopSpeed(r, `${r.name}: ${formatSpeed(top.mps, units)} at ${when(top.ts, period)}`)}
                title={lowerBound ? `Reports come about every ${r.stats.medianIntervalS ?? "?"} s, so the real peak may have been higher.` : "Reported by the collar's GPS"}>
                🏁 Top speed {lowerBound && "≥ "}{formatSpeed(top.mps, units)} at {when(top.ts, period)}
              </button>
            ) : <div className="meta">No movement recorded</div>}
          </div>
        );
      })}
      <p className="hint">Distance ignores GPS wobble and gaps in reporting, so it&apos;s a slight underestimate. Top speed can only be as fast as the reports that caught it.</p>
    </section>
  );
}
