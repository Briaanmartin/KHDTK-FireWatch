"""Offline regression tests for FIRMS parsing, spatial filtering, and outages.

Run: python -m unittest discover -s tests -p "test_*.py"
"""

import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("update_hotspots", ROOT / "scripts" / "update-hotspots.py")
refresh = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(refresh)
NOW = datetime(2026, 10, 11, 15, 0, tzinfo=timezone.utc)
HEADER = "latitude,longitude,acq_date,acq_time,satellite,confidence,frp,bright_ti4,daynight\n"
INSIDE = "-.449,117.215,2026-10-11,1400,N,h,5.0,350,D\n"
NEAR = "-.449,117.4,2026-10-11,1300,N,nominal,3,320,D\n"
OUTSIDE = "-.8,117.215,2026-10-11,1400,N,n,3,320,D\n"
OLD = "-.449,117.215,2026-10-01,1400,N,n,3,320,D\n"
FIXTURE = HEADER + INSIDE + INSIDE + NEAR + OUTSIDE + OLD


class ParsingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        boundary = json.loads((ROOT / "data" / "boundary.geojson").read_text(encoding="utf-8"))
        cls.polygons = refresh.polygon_coordinates(boundary)
        cls.bbox = refresh.buffer_bbox(refresh.boundary_bbox(cls.polygons))

    def parse(self, text):
        return refresh.parse_csv(text, refresh.SOURCES[0], self.polygons, self.bbox, NOW)

    def test_real_khdtk_boundary_and_25_km_buffer(self):
        self.assertEqual(refresh.locate(117.215, -.449, self.polygons), (True, 0.0))
        inside, distance = refresh.locate(117.215, -.7, self.polygons)
        self.assertFalse(inside)
        self.assertGreater(distance, 25)
        self.assertLess(distance, 28)
        # Inside the bounding box, but outside the angled SHP polygon.
        self.assertFalse(refresh.locate(117.2033, -.4385, self.polygons)[0])

    def test_filters_old_and_distant_records_and_deduplicates_one_pass(self):
        features, count, latest = self.parse(FIXTURE)
        self.assertEqual(count, 5)
        self.assertEqual(len(features), 2)
        self.assertEqual(latest, "2026-10-11T14:00:00Z")
        self.assertEqual([f["properties"]["confidence"] for f in features], ["high", "nominal"])
        self.assertEqual([f["properties"]["inside_aoi"] for f in features], [True, False])
        self.assertTrue(all(not f["properties"]["stale"] for f in features))

    def test_same_pixel_from_different_satellites_remains_separate(self):
        ids = []
        for source in refresh.SOURCES:
            records, _, _ = refresh.parse_csv(HEADER + INSIDE, source, self.polygons, self.bbox, NOW)
            ids.append(records[0]["id"])
        self.assertEqual(len(set(ids)), 3)

    def test_rejects_html_and_impossible_coordinates_and_future_times(self):
        for text in ["<html>Service unavailable</html>",
                     HEADER + INSIDE.replace("117.215", "500"),
                     HEADER + INSIDE.replace("2026-10-11", "2026-10-12")]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                self.parse(text)

    def test_valid_zero_rows_has_no_observation_timestamp(self):
        records, count, latest = self.parse(HEADER)
        self.assertEqual((records, count, latest), ([], 0, None))

    def test_stale_upstream_file_is_a_failure_even_when_http_succeeds(self):
        with patch.object(refresh, "fetch_csv", return_value=(FIXTURE, refresh.iso(NOW - timedelta(days=3)))):
            records, status = refresh.collect(refresh.SOURCES[0], self.polygons, self.bbox, NOW)
        self.assertIsNone(records)
        self.assertEqual(status["state"], "error")
        self.assertIn("48 hours", status["error"])


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name)
        (self.data / "boundary.geojson").write_bytes((ROOT / "data" / "boundary.geojson").read_bytes())

    def update(self, now=NOW):
        with contextlib.redirect_stdout(io.StringIO()):
            return refresh.update(self.data, now)

    def seed(self):
        with patch.object(refresh, "fetch_csv", return_value=(FIXTURE, refresh.iso(NOW))):
            status = self.update()
        self.assertEqual(status["state"], "ready")
        self.assertEqual(status["feature_count"], 6)
        return status

    def test_browser_snapshot_embeds_matching_status_and_generation(self):
        status = self.seed()
        snapshot = json.loads((self.data / "hotspots.geojson").read_text(encoding="utf-8"))
        external_status = json.loads((self.data / "hotspots-status.json").read_text(encoding="utf-8"))
        self.assertEqual(snapshot["generated_at"], status["checked_at"])
        self.assertEqual(snapshot["status"], status)
        self.assertEqual(snapshot["status"], external_status)
        self.assertEqual(snapshot["status"]["feature_count"], len(snapshot["features"]))

    def features(self):
        return json.loads((self.data / "hotspots.geojson").read_text(encoding="utf-8"))["features"]

    def test_total_outage_retains_recent_data_marks_stale_and_preserves_success_time(self):
        self.seed()
        with patch.object(refresh, "fetch_csv", side_effect=OSError("fixture outage")):
            status = self.update(NOW + timedelta(hours=1))
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["feature_count"], 6)
        self.assertEqual(status["stale_count"], 6)
        self.assertEqual(status["last_success_at"], refresh.iso(NOW))
        self.assertTrue(all(f["properties"]["stale"] for f in self.features()))
        self.assertTrue(all(s["retained_count"] == 2 for s in status["sources"]))

    def test_partial_outage_retains_only_failed_source_and_refreshes_others(self):
        self.seed()
        failed_source = refresh.SOURCES[1]["id"]

        def download(source):
            if source["id"] == failed_source:
                raise OSError("fixture source failure")
            return HEADER, refresh.iso(NOW + timedelta(hours=1))

        with patch.object(refresh, "fetch_csv", side_effect=download):
            status = self.update(NOW + timedelta(hours=1))
        self.assertEqual(status["state"], "partial")
        self.assertEqual(status["feature_count"], 2)
        self.assertEqual(status["stale_count"], 2)
        self.assertEqual({f["properties"]["source"] for f in self.features()}, {failed_source})
        self.assertEqual([s["state"] for s in status["sources"]], ["ready", "error", "ready"])

    def test_expired_fallback_is_removed_and_first_run_outage_is_not_zero_success(self):
        with patch.object(refresh, "fetch_csv", side_effect=OSError("fixture outage")):
            status = self.update()
        self.assertEqual((status["state"], status["feature_count"], status["last_success_at"]), ("error", 0, None))
        self.seed()
        with patch.object(refresh, "fetch_csv", side_effect=OSError("fixture outage")):
            status = self.update(NOW + timedelta(days=8))
        self.assertEqual((status["state"], status["feature_count"]), ("error", 0))
        self.assertEqual(self.features(), [])

    def test_successful_empty_feed_clears_old_data_without_reporting_failure(self):
        self.seed()
        with patch.object(refresh, "fetch_csv", return_value=(HEADER, refresh.iso(NOW))):
            status = self.update()
        self.assertEqual((status["state"], status["feature_count"], status["stale_count"]), ("ready", 0, 0))
        self.assertEqual(self.features(), [])
        self.assertTrue(all(s["state"] == "ready" for s in status["sources"]))


if __name__ == "__main__":
    unittest.main()
