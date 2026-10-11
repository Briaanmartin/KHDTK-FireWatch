#!/usr/bin/env python3
"""Accumulate verified VIIRS observations without inventing missing history.

Snapshots record only successful seven-day source windows. CSV import is offline:
the operator must declare the requested download period and sensor/product; a
minimum/maximum observation time cannot establish coverage when there are no fires.
Coverage describes a retrieved product, not cloud-free satellite observation.
"""

import argparse
import copy
import csv
import hashlib
import importlib.util
import io
import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("history_hotspot_helpers", ROOT / "scripts" / "update-hotspots.py")
hotspots = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hotspots)
UTC = timezone.utc
WITA = timezone(timedelta(hours=8))
SOURCES = {source["id"]: source for source in hotspots.SOURCES}
PRODUCTS = {**{key: (key, "nrt") for key in SOURCES},
            **{key.replace("_NRT", "_SP"): (key, "sp") for key in SOURCES}}
ARCHIVE_REFERENCE = "https://firms.modaps.eosdis.nasa.gov/download/"
SCIENCE_DOCUMENTATION = "https://ladsweb.modaps.eosdis.nasa.gov/archive/Document%20Archive/Science%20Data%20Product%20Documentation/VIIRS_C2_AF-375m_User_Guide_1.0.pdf"
SCIENCE_PRODUCTS = {"VIIRS_SNPP_NRT": "VNP14IMGML", "VIIRS_NOAA20_NRT": "VJ114IMGML", "VIIRS_NOAA21_NRT": "VJ214IMGML"}


def year_bounds(year):
    return (datetime(year, 1, 1, tzinfo=WITA).astimezone(UTC),
            datetime(year + 1, 1, 1, tzinfo=WITA).astimezone(UTC))


def safe_reference(value):
    """Never publish download credentials, query parameters, or local filenames."""
    url = urlsplit(value)
    if url.scheme == "sftp" and url.hostname == "fuoco.geog.umd.edu" and not url.username and not url.password and url.port is None:
        # Only public monthly archive object identifiers; never credentials or
        # arbitrary remote paths. Access instructions are in the NASA guide.
        match = re.fullmatch(r"/data/VIIRS/C2/(VNP14IMGML|VJ114IMGML|VJ214IMGML)/\1\.(20\d{2})(0[1-9]|1[0-2])\.C2\.\d{2}\.csv\.gz", url.path)
        if match and not url.query and not url.fragment:
            return f"sftp://{url.hostname}{url.path}"
        raise ValueError("Unrecognized public UMD monthly archive reference")
    if url.scheme != "https" or url.hostname != "firms.modaps.eosdis.nasa.gov" or url.username or url.password:
        raise ValueError("Reference must be a public HTTPS NASA FIRMS URL")
    if url.path.startswith("/download"):
        return ARCHIVE_REFERENCE
    allowed = {urlsplit(s["url"]).path for s in SOURCES.values()}
    if url.path not in allowed:
        raise ValueError("Use the NASA FIRMS download page or a known public regional feed as reference")
    return f"https://{url.hostname}{url.path}"


def source_contract():
    return [{"id": key, "name": value["name"], "satellite": value["satellite"], "coverage": []}
            for key, value in SOURCES.items()]


def boundary_context(data_dir):
    boundary = hotspots.read_json(data_dir / "boundary.geojson", {})
    polygons = hotspots.polygon_coordinates(boundary)
    digest = hashlib.sha256(json.dumps(polygons, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return polygons, digest


def blank_archive(year, now, fingerprint):
    return {"type": "FeatureCollection", "schema_version": 1, "year": year,
            "timezone": "Asia/Makassar", "generated_at": hotspots.iso(now),
            "boundary_sha256": fingerprint, "features": [], "sources": source_contract(),
            "confirmed_fires": None}


def feature_key(feature):
    props = feature["properties"]
    lon, lat = feature["geometry"]["coordinates"]
    return f"{props['satellite']}|{props['detected_at']}|{lon:.5f}|{lat:.5f}"


def normalize_feature(feature, polygons):
    """Copy only the public observation fields, and independently clip to AOI."""
    try:
        props = feature["properties"]
        source = props["source"]
        canonical, product = PRODUCTS[source]
        satellite = SOURCES[canonical]["satellite"]
        if feature["type"] != "Feature" or feature["geometry"]["type"] != "Point":
            raise ValueError("Historical observations must be GeoJSON Points")
        if props.get("satellite") != satellite or props.get("instrument") != "VIIRS":
            raise ValueError("Historical source and satellite/instrument do not match")
        lon, lat = feature["geometry"]["coordinates"][:2]
        if not (math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90):
            raise ValueError("Historical coordinates are invalid")
        observed = hotspots.parse_time(props["detected_at"])
        confidence = props["confidence"]
        if confidence not in ("high", "nominal", "low"):
            raise ValueError("Historical VIIRS confidence is invalid")
        identifier = feature.get("id", props.get("id"))
        if not isinstance(identifier, str) or not identifier or len(identifier) > 100 or not identifier.isascii() or any(ord(c) < 32 for c in identifier):
            raise ValueError("Historical feature id is invalid")
        if props.get("id", identifier) != identifier:
            raise ValueError("Historical feature ids do not match")
        if not hotspots.locate(lon, lat, polygons)[0]:
            return None
        normalized = {"id": identifier, "detected_at": hotspots.iso(observed),
                      "latitude": lat, "longitude": lon, "confidence": confidence,
                      "satellite": satellite, "instrument": "VIIRS", "source": source,
                      "product": product, "inside_aoi": True, "distance_km": 0, "stale": False}
        for name in ("frp", "brightness", "scan_km", "track_km"):
            normalized[name] = hotspots.number(props.get(name))
        normalized["daynight"] = props.get("daynight") if props.get("daynight") in ("D", "N") else ""
        return {"type": "Feature", "id": identifier, "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": normalized}
    except (KeyError, TypeError, IndexError, OverflowError) as error:
        raise ValueError("Invalid historical observation schema") from error


def merge_features(existing, incoming):
    merged = {feature_key(feature): copy.deepcopy(feature) for feature in existing}
    for feature in incoming:
        key = feature_key(feature)
        old = merged.get(key)
        if old and old["properties"]["product"] == "sp" and feature["properties"]["product"] != "sp":
            continue
        replacement = copy.deepcopy(feature)
        if old:
            # Keep saved links/ids stable when standard processing replaces NRT.
            replacement["id"] = old["id"]
            replacement["properties"]["id"] = old["id"]
        merged[key] = replacement
    return sorted(merged.values(), key=lambda feature: (feature["properties"]["detected_at"], feature["id"]), reverse=True)


def merge_coverage(intervals):
    grouped = {}
    for interval in intervals:
        start, end = hotspots.parse_time(interval["start"]), hotspots.parse_time(interval["end"])
        if start >= end or interval["kind"] not in ("nrt", "sp"):
            raise ValueError("Invalid historical coverage interval")
        reference = safe_reference(interval["reference"])
        grouped.setdefault((interval["kind"], reference), []).append((start, end))
    result = []
    for (kind, reference), periods in grouped.items():
        combined = []
        for start, end in sorted(periods):
            if combined and start <= combined[-1][1]:
                combined[-1] = (combined[-1][0], max(end, combined[-1][1]))
            else:
                combined.append((start, end))
        for start, end in combined:
            interval = {"start": hotspots.iso(start), "end": hotspots.iso(end), "kind": kind, "reference": reference}
            if reference.startswith("sftp://"):
                interval["documentation"] = SCIENCE_DOCUMENTATION
            result.append(interval)
    return sorted(result, key=lambda item: (item["start"], item["end"], item["kind"]))


def load_archive(data_dir, year, now, polygons, fingerprint):
    archive = hotspots.read_json(data_dir / f"history-{year}.json", None)
    if archive is None:
        return blank_archive(year, now, fingerprint)
    try:
        if (archive["schema_version"] != 1 or archive["type"] != "FeatureCollection" or archive["year"] != year
                or archive["timezone"] != "Asia/Makassar" or archive["confirmed_fires"] is not None
                or archive["boundary_sha256"] != fingerprint):
            raise ValueError("Archive schema/year/boundary mismatch; existing history was not replaced")
        features = [normalize_feature(feature, polygons) for feature in archive["features"]]
        if any(feature is None or hotspots.parse_time(feature["properties"]["detected_at"]).astimezone(WITA).year != year
               for feature in features):
            raise ValueError("Saved history contains out-of-AOI or wrong-year records")
        result = blank_archive(year, now, fingerprint)
        result["features"] = merge_features([], features)
        original_sources = {source["id"]: source for source in archive["sources"]}
        if set(original_sources) != set(SOURCES) or len(original_sources) != len(archive["sources"]):
            raise ValueError("Archive source schema is invalid")
        lower, upper = year_bounds(year)
        for source in result["sources"]:
            intervals = merge_coverage(original_sources[source["id"]]["coverage"])
            if any(hotspots.parse_time(item["start"]) < lower or hotspots.parse_time(item["end"]) > upper for item in intervals):
                raise ValueError("Saved coverage exceeds its WITA calendar year")
            source["coverage"] = intervals
        return result
    except (KeyError, TypeError, IndexError) as error:
        raise ValueError("Invalid saved history schema; existing history was not replaced") from error


def persist(data_dir, features, intervals, now, ensure_year=None):
    polygons, fingerprint = boundary_context(data_dir)
    years = {hotspots.parse_time(feature["properties"]["detected_at"]).astimezone(WITA).year for feature in features}
    for _, interval in intervals:
        start, end = hotspots.parse_time(interval["start"]), hotspots.parse_time(interval["end"])
        years.update(range(start.astimezone(WITA).year, (end - timedelta(microseconds=1)).astimezone(WITA).year + 1))
    if ensure_year is not None:
        years.add(ensure_year)
    archives = {}
    for year in sorted(years):
        archive = load_archive(data_dir, year, now, polygons, fingerprint)
        lower, upper = year_bounds(year)
        archive["features"] = merge_features(archive["features"], [feature for feature in features
                                             if lower <= hotspots.parse_time(feature["properties"]["detected_at"]) < upper])
        by_source = {source["id"]: source for source in archive["sources"]}
        for source_id, interval in intervals:
            start = max(lower, hotspots.parse_time(interval["start"]))
            end = min(upper, hotspots.parse_time(interval["end"]))
            if start < end:
                by_source[source_id]["coverage"].append({**interval, "start": hotspots.iso(start), "end": hotspots.iso(end)})
        for source in archive["sources"]:
            source["coverage"] = merge_coverage(source["coverage"])
        archives[year] = archive
    # Validate every affected archive before replacing any file.
    for year, archive in archives.items():
        hotspots.write_json(data_dir / f"history-{year}.json", archive)
    return archives


def update_history(data_dir, snapshot, now):
    """Archive one atomic snapshot. Source outages never extend coverage."""
    data_dir = Path(data_dir)
    if now.tzinfo is None:
        raise ValueError("Archive update time must include timezone")
    now = hotspots.parse_time(hotspots.iso(now))
    try:
        status = snapshot["status"]
        checked = hotspots.parse_time(status["checked_at"])
        if (snapshot["type"] != "FeatureCollection" or status["schema_version"] != 1
                or snapshot["generated_at"] != status["checked_at"] or checked > now):
            raise ValueError("Snapshot metadata is inconsistent or from the future")
        end = min(hotspots.parse_time(status["window_end"]), checked, now)
        start = max(hotspots.parse_time(status["window_start"]), end - timedelta(days=7))
        if start >= end:
            raise ValueError("Snapshot coverage window is invalid")
        ready, seen = {}, set()
        for source in status["sources"]:
            if source["id"] not in SOURCES or source["state"] not in ("ready", "error") or source["id"] in seen:
                raise ValueError("Snapshot source schema is invalid")
            seen.add(source["id"])
            if source["state"] == "ready":
                ready[source["id"]] = source
        polygons, _ = boundary_context(data_dir)
        features = []
        for feature in snapshot["features"]:
            props = feature["properties"]
            if props["source"] not in ready or props.get("stale", False):
                continue
            normalized = normalize_feature(feature, polygons)
            if normalized and start <= hotspots.parse_time(normalized["properties"]["detected_at"]) <= end:
                features.append(normalized)
        intervals = [(key, {"start": hotspots.iso(start), "end": hotspots.iso(end), "kind": "nrt",
                            "reference": safe_reference(source["url"])}) for key, source in ready.items()]
        return persist(data_dir, features, intervals, now, ensure_year=now.astimezone(WITA).year)
    except (KeyError, TypeError, IndexError) as error:
        raise ValueError("Invalid hotspot snapshot schema; history was not replaced") from error


def parse_archive_csv(text, source_id, polygons, start, end):
    """Parse VIIRS CSV without a rolling seven-day cutoff; exact AOI clip only."""
    if source_id not in PRODUCTS:
        raise ValueError("Choose a supported VIIRS sensor/product source")
    canonical, product = PRODUCTS[source_id]
    source = SOURCES[canonical]
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    required = {"latitude", "longitude", "acq_date", "acq_time", "confidence", "frp", "satellite"}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError("Historical NASA CSV has missing required columns")
    aliases = {"S-NPP": {"N", "S-NPP", "SNPP", "SUOMI-NPP"},
               "NOAA-20": {"1", "N20", "J1", "NOAA-20", "NOAA20"},
               "NOAA-21": {"2", "N21", "J2", "NOAA-21", "NOAA21"}}
    features = []
    for row in reader:
        try:
            if row["satellite"].strip().upper() not in aliases[source["satellite"]]:
                raise ValueError("CSV satellite differs from the explicitly selected source")
            if row.get("instrument", "VIIRS").strip().upper() != "VIIRS":
                raise ValueError("Only VIIRS archive CSV is supported")
            lon, lat = float(row["longitude"]), float(row["latitude"])
            clock = row["acq_time"].strip().zfill(4)
            observed = datetime.strptime(row["acq_date"] + clock, "%Y-%m-%d%H%M").replace(tzinfo=UTC)
            timestamp = hotspots.iso(observed)
            confidence = row["confidence"].strip().lower()
            confidence = {"h": "high", "n": "nominal", "l": "low"}.get(confidence, confidence)
            identifier = hashlib.sha256(f"{source_id}|{timestamp}|{lon:.5f}|{lat:.5f}".encode()).hexdigest()[:20]
            feature = normalize_feature({"type": "Feature", "id": identifier,
                "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": {
                    "id": identifier, "detected_at": timestamp, "confidence": confidence,
                    "satellite": source["satellite"], "instrument": "VIIRS", "source": source_id,
                    "product": product, "frp": row["frp"], "brightness": row.get("bright_ti4"),
                    "daynight": row.get("daynight"), "scan_km": row.get("scan"), "track_km": row.get("track")}}, polygons)
            if feature and start <= observed < end:
                features.append(feature)
        except (TypeError, KeyError) as error:
            raise ValueError("Invalid historical NASA CSV row") from error
    return merge_features([], features)


def import_csv(data_dir, csv_texts, source_id, start, end, now, reference=ARCHIVE_REFERENCE):
    """Import a verified download with an explicit [start, end) product period."""
    data_dir = Path(data_dir)
    if source_id not in PRODUCTS or start.tzinfo is None or end.tzinfo is None or start >= end or end > now:
        raise ValueError("Declare a supported source and a valid past coverage period with timezone")
    if not csv_texts:
        raise ValueError("At least one CSV download is required")
    polygons, _ = boundary_context(data_dir)
    features = []
    for text in csv_texts:
        features.extend(parse_archive_csv(text, source_id, polygons, start, end))
    canonical, product = PRODUCTS[source_id]
    reference = safe_reference(reference)
    if reference.startswith("sftp://") and (product != "sp" or f"/{SCIENCE_PRODUCTS[canonical]}/" not in reference):
        raise ValueError("Monthly science archive provenance differs from the selected source/product")
    interval = {"start": hotspots.iso(start), "end": hotspots.iso(end), "kind": product, "reference": reference}
    return persist(data_dir, features, [(canonical, interval)], now)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--snapshot", type=Path, help="Existing atomic hotspots.geojson; default is data-dir/hotspots.geojson")
    parser.add_argument("--csv", nargs="+", type=Path, help="Verified NASA VIIRS CSV download(s), all from one source/product")
    parser.add_argument("--source", choices=sorted(PRODUCTS))
    parser.add_argument("--coverage-start", help="Inclusive ISO timestamp with timezone of the requested download period")
    parser.add_argument("--coverage-end", help="Exclusive ISO timestamp with timezone of the requested download period")
    parser.add_argument("--reference", default=ARCHIVE_REFERENCE, help="Public NASA provenance URL; credentials and query strings are not published")
    args = parser.parse_args()
    now = datetime.now(UTC)
    if args.csv:
        if args.snapshot or not all([args.source, args.coverage_start, args.coverage_end]):
            parser.error("CSV import requires --source, --coverage-start and --coverage-end; do not combine with --snapshot")
        result = import_csv(args.data_dir, [path.read_text(encoding="utf-8-sig") for path in args.csv], args.source,
                            hotspots.parse_time(args.coverage_start), hotspots.parse_time(args.coverage_end), now, args.reference)
    else:
        if args.source or args.coverage_start or args.coverage_end:
            parser.error("Source and coverage options require --csv")
        result = update_history(args.data_dir, hotspots.read_json(args.snapshot or args.data_dir / "hotspots.geojson", {}), now)
    for year, archive in result.items():
        periods = sum(len(source["coverage"]) for source in archive["sources"])
        print(f"history-{year}.json: {len(archive['features'])} AOI observations, {periods} source coverage intervals; confirmed fires unknown")


if __name__ == "__main__":
    main()
