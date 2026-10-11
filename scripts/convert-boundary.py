#!/usr/bin/env python3
"""Convert user-supplied SHP/KML into validated WGS84 layers for FireWatch.

Install: python -m pip install pyshp pyproj shapely
Run: python scripts/convert-boundary.py --shapefile "path/AOI KRUS.shp" \
     --kml "path/KHDTK .kml"

The SHP is the primary boundary. KML polygons are retained as a separate
reference area; KML placemark points are recorded in boundary-info.json.
"""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
import xml.etree.ElementTree as ET

import shapefile
from pyproj import CRS, Geod, Transformer
import shapely
from shapely.geometry import MultiPolygon, Polygon, mapping, shape
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

DISPLAY_NAME = "KHDTK Diklathut Fahutan Unmul Lempake"
GEOD = Geod(ellps="WGS84")
KML_NS = {"k": "http://www.opengis.net/kml/2.2"}


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def orient_geometry(geometry):
    if isinstance(geometry, Polygon):
        return orient(geometry, sign=1.0)
    if isinstance(geometry, MultiPolygon):
        return MultiPolygon([orient(part, sign=1.0) for part in geometry.geoms])
    raise ValueError(f"Expected polygon geometry; received {geometry.geom_type}")


def area_ha(geometry):
    return abs(GEOD.geometry_area_perimeter(orient_geometry(geometry))[0]) / 10000


def validate(geometry, label):
    if geometry.is_empty or not geometry.is_valid:
        raise ValueError(f"Invalid {label}: {shapely.is_valid_reason(geometry)}")
    xmin, ymin, xmax, ymax = geometry.bounds
    if not (-180 <= xmin <= xmax <= 180 and -90 <= ymin <= ymax <= 90):
        raise ValueError(f"{label} is not in WGS84 longitude/latitude coordinates")


def collection(features, geometry):
    return {"type": "FeatureCollection", "bbox": list(geometry.bounds), "features": features}


def parse_coordinates(element):
    if element is None or not element.text:
        raise ValueError("KML polygon is missing coordinates")
    return [tuple(map(float, item.split(",")[:2])) for item in element.text.split()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shapefile", type=Path, required=True)
    parser.add_argument("--kml", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("data"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    crs = CRS.from_wkt(args.shapefile.with_suffix(".prj").read_text(encoding="utf-8"))
    to_wgs84 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    to_source = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    features = []
    source_points = 0
    cleaned_points = 0
    max_roundtrip_error_m = 0.0
    with shapefile.Reader(str(args.shapefile)) as reader:
        for index, record in enumerate(reader.iterShapeRecords()):
            projected = shape(record.shape.__geo_interface__)
            source_points += shapely.get_num_coordinates(projected)
            clean = shapely.remove_repeated_points(projected, tolerance=0.0)
            cleaned_points += shapely.get_num_coordinates(clean)
            wgs84 = orient_geometry(shapely.transform(clean, to_wgs84.transform, interleaved=False))
            validate(wgs84, f"SHP feature {index + 1}")
            reverse = shapely.transform(wgs84, to_source.transform, interleaved=False)
            max_roundtrip_error_m = max(max_roundtrip_error_m, clean.hausdorff_distance(reverse))
            if max_roundtrip_error_m > 0.01:
                raise ValueError("Coordinate transform round-trip exceeds 1 cm")
            features.append({
                "type": "Feature", "id": f"khdtk-{index + 1}",
                "properties": {
                    "name": DISPLAY_NAME, "role": "boundary",
                    "sourceFile": args.shapefile.name,
                    "sourceCrs": crs.to_string(),
                    "areaHa": round(area_ha(wgs84), 4),
                    "sourceAttributes": record.record.as_dict(),
                },
                "geometry": mapping(wgs84),
            })
    boundary = unary_union([shape(feature["geometry"]) for feature in features])
    validate(boundary, "combined SHP boundary")

    kml = ET.parse(args.kml).getroot()
    aoi_features = []
    reference_points = []
    for placemark in kml.findall(".//k:Placemark", KML_NS):
        source_name = placemark.findtext("k:name", default="", namespaces=KML_NS)
        for element in placemark.findall(".//k:Polygon", KML_NS):
            outer = parse_coordinates(element.find("k:outerBoundaryIs/k:LinearRing/k:coordinates", KML_NS))
            holes = [parse_coordinates(inner) for inner in element.findall("k:innerBoundaryIs/k:LinearRing/k:coordinates", KML_NS)]
            polygon = orient_geometry(Polygon(outer, holes))
            validate(polygon, "KML reference area")
            aoi_features.append({
                "type": "Feature", "id": f"aoi-{len(aoi_features) + 1}",
                "properties": {
                    "name": "Area referensi KML", "role": "reference-area",
                    "sourceFile": args.kml.name, "sourceName": source_name,
                    "sourceCrs": "EPSG:4326", "areaHa": round(area_ha(polygon), 4),
                },
                "geometry": mapping(polygon),
            })
        for element in placemark.findall(".//k:Point/k:coordinates", KML_NS):
            coordinates = parse_coordinates(element)[0]
            reference_points.append({"sourceName": source_name, "coordinates": coordinates})
    if not aoi_features:
        raise ValueError("KML does not contain a polygon reference area")
    aoi = unary_union([shape(feature["geometry"]) for feature in aoi_features])
    validate(aoi, "combined KML reference area")
    center = boundary.centroid
    info = {
        "name": DISPLAY_NAME,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "coordinateReferenceSystem": "EPSG:4326",
        "coordinateOrder": "longitude, latitude",
        "bbox": list(boundary.bounds),
        "center": [center.x, center.y],
        "areaHa": round(area_ha(boundary), 4),
        "boundary": {
            "file": "boundary.geojson", "sourceFile": args.shapefile.name,
            "sourceCrs": crs.to_string(), "sourceCrsName": crs.name,
            "featureCount": len(features), "originalCoordinateCount": int(source_points),
            "coordinateCount": int(cleaned_points),
            "processing": "Reproyeksi dari CRS pada .prj ke WGS84; duplikasi koordinat berurutan dihapus tanpa mengubah geometri.",
            "transformDescription": to_wgs84.description,
            "transformAccuracyM": to_wgs84.accuracy,
            "maxRoundtripErrorM": max_roundtrip_error_m,
        },
        "aoi": {
            "file": "aoi.geojson", "sourceFile": args.kml.name,
            "featureCount": len(aoi_features), "bbox": list(aoi.bounds),
            "areaHa": round(area_ha(aoi), 4),
            "coversBoundary": bool(aoi.covers(boundary)),
            "referencePoints": reference_points,
            "note": "Poligon KML lebih luas dan ditampilkan sebagai area referensi terpisah dari batas SHP.",
        },
        "areaMethod": "Luas geodesik pada ellipsoid WGS84, dalam hektare.",
        "sourceAttribution": "Batas dan area referensi berasal dari berkas yang diunggah pengguna.",
    }
    write_json(args.output / "boundary.geojson", collection(features, boundary))
    write_json(args.output / "aoi.geojson", collection(aoi_features, aoi))
    write_json(args.output / "boundary-info.json", info)
    print(json.dumps(info, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
