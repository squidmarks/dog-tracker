"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatDistance, formatDuration, formatSpeed, type Units } from "../lib/units";
import { resolveRange, type LeaderRow, type RangePreset } from "../lib/types";

export type StatsPeriod = Extract<RangePreset, "today" | "yesterday" | "week">;
export const STATS_PERIODS: Record<StatsPeriod, string> = { today: "Today", yesterday: "Yesterday", week: "7 days" };

const when = (ts: number, period: StatsPeriod) =>
  new Date(ts * 1000).toLocaleString([], period === "week"
    ? { weekday: "short", hour: "numeric", minute: "2-digit" } : { hour: "numeric", minute: "2-digit" });

/** Distance, top speed and active time for every dog over a day or a week, refreshed every 30 s. */
export function usePeriodStats(period: StatsPeriod) {
  const [rows, setRows] = useState<Map<string, LeaderRow>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { from, to } = resolveRange({ preset: period });
      setRows(new Map((await api.stats(from, to)).map((r) => [r.dogId, r])));
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [period]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  /** The dog with the highest top speed in this period (only meaningful with more than one dog). */
  let fastest: string | null = null;
  if (rows.size > 1) {
    let best = 0;
    for (const r of rows.values()) if (r.stats.topSpeed && r.stats.topSpeed.mps > best) { best = r.stats.topSpeed.mps; fastest = r.dogId; }
  }
  return { rows, fastest, error };
}

/** The activity block inside a dog's card. */
export function DogStats({ row, period, units, onTopSpeed }: {
  row: LeaderRow | undefined; period: StatsPeriod; units: Units; onTopSpeed: (row: LeaderRow, label: string) => void;
}) {
  if (!row) return <div className="dogstats"><div className="meta">Loading activity…</div></div>;
  const top = row.stats.topSpeed;
  // A speed measured from sparse reports is a floor: the dog may well have gone faster between them.
  const lowerBound = !!top && (top.source === "derived" || (row.stats.medianIntervalS ?? 0) > 20);
  return (
    <div className="dogstats" onClick={(e) => e.stopPropagation()}>
      <div className="statline">
        <span><big>{formatDistance(row.stats.distanceM, units)}</big> travelled</span>
        <span>{formatDuration(row.stats.movingS)} active</span>
      </div>
      {top ? (
        <button className="link topspeed" onClick={() => onTopSpeed(row, `${row.name}: ${formatSpeed(top.mps, units)} at ${when(top.ts, period)}`)}
          title={lowerBound ? `Reports come about every ${row.stats.medianIntervalS ?? "?"} s, so the real peak may have been higher.` : "Reported by the collar's GPS"}>
          🏁 Top speed {lowerBound && "≥ "}{formatSpeed(top.mps, units)} · {when(top.ts, period)}
        </button>
      ) : <div className="meta">No movement recorded</div>}
    </div>
  );
}
