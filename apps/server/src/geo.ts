export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Circular yard with hysteresis: a dog flips to "out" only past radius + margin, and back "in" within radius,
 *  so GPS jitter at the fence line doesn't flap the sensor. */
export class Yard {
  private inside = new Map<string, boolean>();
  constructor(private lat: number, private lon: number, private radiusM: number, private marginM = 8) {}

  update(node: string, lat: number, lon: number): boolean {
    const d = distanceM(this.lat, this.lon, lat, lon);
    const prev = this.inside.get(node);
    const now = prev === undefined ? d <= this.radiusM
      : prev ? d <= this.radiusM + this.marginM
      : d <= this.radiusM;
    this.inside.set(node, now);
    return now;
  }
}
