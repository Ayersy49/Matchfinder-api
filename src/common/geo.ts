// src/common/geo.ts
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
) {
  const R = 6371; // km
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;

  const sin1 = Math.sin(dLat / 2) ** 2;
  const sin2 = Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.asin(
    Math.sqrt(sin1 + Math.cos(lat1) * Math.cos(lat2) * sin2)
  );
  return R * c;
}
