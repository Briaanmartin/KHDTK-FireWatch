#!/usr/bin/env python3
"""Refresh public NASA FIRMS VIIRS detections around the supplied KHDTK boundary.

Python standard library only. The regional 7-day CSV download URLs are listed by
https://firms.modaps.eosdis.nasa.gov/api/active_fire_files/all?format=json and do
not require a MAP_KEY. Detections are satellite observations, not confirmed fires.
"""

import argparse
import copy
import csv
import hashlib
import io
import json
import math
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
UTC = timezone.utc
RADIUS_KM = 6371.0088
WINDOW_DAYS = 7
BUFFER_KM = 25
BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire"
SOURCES = [
    {"id": "VIIRS_SNPP_NRT", "name": "VIIRS S-NPP", "satellite": "S-NPP",
     "url": f"{BASE}/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_SouthEast_Asia_7d.csv"},
    {"id": "VIIRS_NOAA20_NRT", "name": "VIIRS NOAA-20", "satellite": "NOAA-20",
     "url": f"{BASE}/noaa-20-viirs-c2/csv/J1_VIIRS_C2_SouthEast_Asia_7d.csv"},
    {"id": "VIIRS_NOAA21_NRT", "name": "VIIRS NOAA-21", "satellite": "NOAA-21",
     "url": f"{BASE}/noaa-21-viirs-c2/csv/J2_VIIRS_C2_SouthEast_Asia_7d.csv"},
]


def iso(value):
    return value.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_time(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Timestamp must include timezone")
    return result.astimezone(UTC)


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return default


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def polygon_coordinates(document):
    """Return polygons, retaining interior rings, from WGS84 GeoJSON."""
    polygons = []
    for feature in document.get("features", [document]):
        geometry = feature.get("geometry", feature)
        kind = geometry.get("type")
        if kind == "Polygon":
            polygons.append(geometry["coordinates"])
        elif kind == "MultiPolygon":
            polygons.extend(geometry["coordinates"])
    if not polygons or any(len(ring) < 4 for p in polygons for ring in p):
        raise ValueError("Boundary requires valid Polygon or MultiPolygon coordinates")
    for polygon in polygons:
        for ring in polygon:
            for lon, lat, *_ in ring:
                if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                    raise ValueError("Boundary must use WGS84 longitude/latitude")
    return polygons


def point_in_ring(lon, lat, ring):
    inside = False
    for a, b in zip(ring, ring[1:]):
        if (a[1] > lat) != (b[1] > lat):
            crossing = a[0] + (lat - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
            if lon < crossing:
                inside = not inside
    return inside


def angular_distance(a, b):
    lon1, lat1 = map(math.radians, a[:2])
    lon2, lat2 = map(math.radians, b[:2])
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * math.asin(math.sqrt(min(1, max(0, h))))


def bearing(a, b):
    lon1, lat1 = map(math.radians, a[:2])
    lon2, lat2 = map(math.radians, b[:2])
    return math.atan2(math.sin(lon2 - lon1) * math.cos(lat2),
                      math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1))


def segment_distance(point, start, end):
    """Shortest spherical distance to a bounded great-circle segment, in km."""
    length = angular_distance(start, end)
    from_start = angular_distance(start, point)
    if length < 1e-12:
        return RADIUS_KM * from_start
    angle = bearing(start, point) - bearing(start, end)
    along = math.atan2(math.sin(from_start) * math.cos(angle), math.cos(from_start))
    if along < 0 or along > length:
        return RADIUS_KM * min(from_start, angular_distance(end, point))
    return RADIUS_KM * abs(math.asin(max(-1, min(1, math.sin(from_start) * math.sin(angle)))))


def locate(lon, lat, polygons):
    inside = any(point_in_ring(lon, lat, p[0]) and not any(point_in_ring(lon, lat, hole) for hole in p[1:]) for p in polygons)
    if inside:
        return True, 0.0
    distance = min(segment_distance([lon, lat], a, b) for p in polygons for ring in p for a, b in zip(ring, ring[1:]))
    return distance < 0.000001, distance


def boundary_bbox(polygons):
    points = [point for p in polygons for ring in p for point in ring]
    return [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)]


def buffer_bbox(bbox):
    # Conservative preliminary search envelope; final test uses polygon distance.
    dy = math.degrees(BUFFER_KM / RADIUS_KM) + 0.001
    dx = dy / math.cos(math.radians(max(abs(bbox[1]), abs(bbox[3])) + dy))
    return [bbox[0] - dx, bbox[1] - dy, bbox[2] + dx, bbox[3] + dy]


def number(value):
    if value in (None, ""):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def fetch_csv(source):
    request = urllib.request.Request(source["url"], headers={"User-Agent": "KHDTK-FireWatch/1.0 (+https://github.com/briaanmartin/KHDTK-FireWatch)", "Accept": "text/csv"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read(60_000_001)
                if len(data) > 60_000_000:
                    raise ValueError("Regional feed exceeds 60 MB limit")
                modified = response.headers.get("Last-Modified")
            return data.decode("utf-8-sig"), iso(parsedate_to_datetime(modified)) if modified else None
        except (OSError, UnicodeError, ValueError):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def parse_csv(text, source, polygons, bbox, now):
    reader = csv.DictReader(io.StringIO(text))
    required = {"latitude", "longitude", "acq_date", "acq_time", "confidence", "frp", "satellite"}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError("NASA response has missing CSV columns; data was not replaced")
    cutoff = now - timedelta(days=WINDOW_DAYS)
    records = {}
    row_count = 0
    latest = None
    for row in reader:
        row_count += 1
        lon, lat = float(row["longitude"]), float(row["latitude"])
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise ValueError(f"Invalid coordinate in NASA CSV row {row_count}")
        clock = row["acq_time"].strip().zfill(4)
        observed = datetime.strptime(row["acq_date"] + clock, "%Y-%m-%d%H%M").replace(tzinfo=UTC)
        if observed > now + timedelta(minutes=15):
            raise ValueError("NASA feed includes unexpected future observation times")
        latest = max(latest, observed) if latest else observed
        if observed < cutoff or observed > now:
            continue
        if not (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]):
            continue
        inside, distance = locate(lon, lat, polygons)
        if distance > BUFFER_KM:
            continue
        confidence = {"h": "high", "n": "nominal", "l": "low"}.get(row["confidence"].lower(), row["confidence"].lower())
        if confidence not in ("high", "nominal", "low"):
            raise ValueError(f"Unknown VIIRS confidence: {confidence}")
        timestamp = iso(observed)
        key = f"{source['id']}|{timestamp}|{lon:.5f}|{lat:.5f}"
        identifier = hashlib.sha256(key.encode()).hexdigest()[:20]
        records[key] = {
            "type": "Feature", "id": identifier,
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "id": identifier, "detected_at": timestamp, "latitude": lat, "longitude": lon,
                "confidence": confidence, "satellite": source["satellite"], "instrument": "VIIRS",
                "source": source["id"], "frp": number(row["frp"]), "brightness": number(row.get("bright_ti4")),
                "daynight": row.get("daynight", ""), "scan_km": number(row.get("scan")), "track_km": number(row.get("track")),
                "inside_aoi": inside, "distance_km": round(distance, 3), "stale": False,
            },
        }
    return list(records.values()), row_count, iso(latest) if latest else None


def collect(source, polygons, bbox, now):
    try:
        text, modified = fetch_csv(source)
        features, rows, latest = parse_csv(text, source, polygons, bbox, now)
        # A current HTTP response can still contain an old upstream product.
        if modified and parse_time(modified) < now - timedelta(hours=48):
            raise ValueError(f"NASA source file has not been updated in over 48 hours ({modified})")
        if latest and parse_time(latest) < now - timedelta(hours=48):
            raise ValueError(f"Latest regional observation is more than 48 hours old ({latest})")
        return features, {**source, "state": "ready", "last_success_at": iso(now),
                          "source_updated_at": modified, "latest_detection_at": latest,
                          "regional_rows": rows, "feature_count": len(features), "retained_count": 0, "error": None}
    except Exception as error:
        # Preserve per-source previous observations, but never present them as fresh.
        return None, {**source, "state": "error", "error": f"{type(error).__name__}: {error}"[:500]}


def update(data_dir, now):
    polygons = polygon_coordinates(read_json(data_dir / "boundary.geojson", {}))
    bbox = buffer_bbox(boundary_bbox(polygons))
    old_features = read_json(data_dir / "hotspots.geojson", {"features": []}).get("features", [])
    old_status = read_json(data_dir / "hotspots-status.json", {})
    old_sources = {s["id"]: s for s in old_status.get("sources", [])}
    cutoff = now - timedelta(days=WINDOW_DAYS)
    features, statuses = [], []
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda s: collect(s, polygons, bbox, now), SOURCES))
    for source, (fresh, status) in zip(SOURCES, results):
        if fresh is None:
            fresh = []
            for feature in old_features:
                props = feature.get("properties", {})
                if props.get("source") != source["id"]:
                    continue
                try:
                    if not cutoff <= parse_time(props["detected_at"]) <= now:
                        continue
                    lon, lat = feature["geometry"]["coordinates"][:2]
                    inside, distance = locate(lon, lat, polygons)
                    if distance > BUFFER_KM:
                        continue
                except (KeyError, TypeError, ValueError):
                    continue
                retained = copy.deepcopy(feature)
                retained["properties"].update(stale=True, inside_aoi=inside, distance_km=round(distance, 3))
                fresh.append(retained)
            prior = old_sources.get(source["id"], {})
            status.update(last_success_at=prior.get("last_success_at"), source_updated_at=prior.get("source_updated_at"),
                          latest_detection_at=prior.get("latest_detection_at"), regional_rows=None,
                          feature_count=len(fresh), retained_count=len(fresh))
        features.extend(fresh)
        statuses.append(status)
        print(f"{source['id']}: {status['state']}, {len(fresh)} detections" + (f"; {status['error']}" if status.get("error") else ""))
    features.sort(key=lambda f: (f["properties"]["detected_at"], f["id"]), reverse=True)
    success_count = sum(s["state"] == "ready" for s in statuses)
    state = "ready" if success_count == len(SOURCES) else "partial" if success_count else "error"
    messages = {
        "ready": "Data NASA FIRMS berhasil diperbarui. Hotspot merupakan indikasi panas satelit dan perlu verifikasi lapangan.",
        "partial": "Sebagian sumber NASA FIRMS gagal diperbarui. Data lama yang masih dalam 7 hari ditandai kedaluwarsa.",
        "error": "Pembaruan NASA FIRMS gagal. Data lama yang masih dalam 7 hari dipertahankan dan ditandai kedaluwarsa; kondisi terkini belum diketahui.",
    }
    status = {
        "schema_version": 1, "checked_at": iso(now), "state": state,
        "last_success_at": iso(now) if state == "ready" else old_status.get("last_success_at"),
        "window_start": iso(cutoff), "window_end": iso(now), "window_days": WINDOW_DAYS,
        "buffer_km": BUFFER_KM, "boundary_file": "boundary.geojson", "search_bbox": bbox,
        "distance_method": "Jarak sferis terpendek ke batas SHP; radius bumi 6371.0088 km.",
        "feature_count": len(features), "inside_count": sum(f["properties"]["inside_aoi"] for f in features),
        "stale_count": sum(f["properties"]["stale"] for f in features),
        "latest_detection_at": max((f["properties"]["detected_at"] for f in features), default=None),
        "sources": statuses, "message": messages[state],
        "attribution": "NASA FIRMS / LANCE, VIIRS 375 m Near Real-Time, Collection 2",
        "source_documentation": "https://firms.modaps.eosdis.nasa.gov/active_fire/",
    }
    # Keep browser observations and their health metadata in a single HTTP object.
    # The separate status file remains available for workflow summaries.
    write_json(data_dir / "hotspots.geojson", {
        "type": "FeatureCollection", "generated_at": iso(now),
        "status": status, "features": features,
    })
    write_json(data_dir / "hotspots-status.json", status)
    print(f"Saved {len(features)} detections, {status['inside_count']} inside boundary; status={state}")
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    args = parser.parse_args()
    update(args.data_dir, datetime.now(UTC))


if __name__ == "__main__":
    main()
