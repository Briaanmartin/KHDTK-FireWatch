export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
    if (Math.abs(cross) < 1e-12 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return true;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function insideGeometry(point, geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some(rings => pointInRing(point, rings[0]) && !rings.slice(1).some(ring => pointInRing(point, ring)));
}
export function insideBoundary(point, boundary) {
  return boundary.features.some(feature => insideGeometry(point, feature.geometry));
}
// Local tangent-plane approximation for map-scale proximity within 25 km of Lempake.
export function distanceToBoundaryKm(point, boundary) {
  if (insideBoundary(point, boundary)) return 0;
  const rad = Math.PI / 180, scale = 6371.0088 * rad, cos = Math.cos(point[1] * rad);
  let distance = Infinity;
  for (const feature of boundary.features) {
    const geometry = feature.geometry;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    for (const rings of polygons) for (const ring of rings) for (let i = 1; i < ring.length; i++) {
      const a = [(ring[i - 1][0] - point[0]) * scale * cos, (ring[i - 1][1] - point[1]) * scale];
      const b = [(ring[i][0] - point[0]) * scale * cos, (ring[i][1] - point[1]) * scale];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / (dx * dx + dy * dy || 1)));
      distance = Math.min(distance, Math.hypot(a[0] + t * dx, a[1] + t * dy));
    }
  }
  return distance;
}
export function normalizeConfidence(value) {
  const text = String(value ?? '').toLowerCase();
  if (['h','high','tinggi'].includes(text)) return 'high';
  if (['n','nominal','medium','sedang'].includes(text)) return 'nominal';
  if (['l','low','rendah'].includes(text)) return 'low';
  return 'unknown';
}
export function filterDetections(features, {hours = 168, confidence = 'all', scope = 'all', now = Date.now()} = {}) {
  return features.filter(feature => {
    const p = feature.properties, time = Date.parse(p.detected_at);
    return Number.isFinite(time) && time <= now && time >= now - hours * 3600000 &&
      (confidence === 'all' || p.confidence === confidence) &&
      (scope === 'all' || (scope === 'inside' ? p.inside : !p.inside));
  });
}
export function toCSV(features) {
  const quote = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  const rows = [['waktu_utc','satelit','sensor','kepercayaan','frp_mw','longitude','latitude','dalam_khdtk','jarak_batas_km','sumber','data_lama'], ...features.map(f => {
    const p = f.properties;
    return [p.detected_at,p.satellite,p.instrument,p.confidence,p.frp,...f.geometry.coordinates,p.inside,p.distance_km.toFixed(3),p.source,Boolean(p.stale)];
  })];
  return '\uFEFF' + rows.map(row => row.map(quote).join(',')).join('\r\n');
}
