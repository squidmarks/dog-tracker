const M_PER_DEG = 111_195;

export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function circleRing(lat: number, lon: number, radiusM: number, points = 48): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i < points; i++) {
    const a = (2 * Math.PI * i) / points;
    ring.push([lon + (Math.cos(a) * radiusM) / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)), lat + (Math.sin(a) * radiusM) / M_PER_DEG]);
  }
  ring.push(ring[0]);
  return ring;
}
