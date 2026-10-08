/** Thin a time-ordered track to at most `max` points, always keeping the first and last (so ranges stay accurate). */
export function decimate<T>(points: T[], max: number): T[] {
  if (points.length <= max || max < 3) return points;
  const stride = (points.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.round(i * stride)]);
  out.push(points[points.length - 1]);
  return out;
}
