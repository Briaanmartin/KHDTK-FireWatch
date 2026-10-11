"""Offline tests for archival provenance, AOI clipping, gaps and product upgrades."""

import copy
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("firewatch_history", ROOT / "scripts" / "history.py")
history = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(history)
UTC = timezone.utc
NOW = datetime(2026, 10, 11, 15, 0, tzinfo=UTC)
HEADER = "latitude,longitude,acq_date,acq_time,satellite,confidence,frp,bright_ti4,daynight\n"
ROW = "-.449,117.215,2026-01-15,1400,N,h,5,350,D\n"


def feature(at, source="VIIRS_SNPP_NRT", lon=117.215, lat=-.449, identifier="existing-id"):
    return {"type": "Feature", "id": identifier, "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"id": identifier, "detected_at": history.hotspots.iso(at), "source": source,
                           "satellite": history.SOURCES[history.PRODUCTS[source][0]]["satellite"],
                           "instrument": "VIIRS", "confidence": "high", "frp": 5,
                           "inside_aoi": True, "stale": False}}


def snapshot(at=NOW, features=None, failures=()):
    sources = [{**source, "state": "error" if key in failures else "ready"} for key, source in history.SOURCES.items()]
    return {"type": "FeatureCollection", "generated_at": history.hotspots.iso(at), "features": features or [],
            "status": {"schema_version": 1, "checked_at": history.hotspots.iso(at),
                       "window_start": history.hotspots.iso(at - timedelta(days=7)), "window_end": history.hotspots.iso(at),
                       "sources": sources}}


class HistoryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.data = Path(directory.name)
        (self.data / "boundary.geojson").write_bytes((ROOT / "data" / "boundary.geojson").read_bytes())

    def update(self, document=None, now=NOW):
        return history.update_history(self.data, document or snapshot(), now)

    def archive(self, year=2026):
        return json.loads((self.data / f"history-{year}.json").read_text(encoding="utf-8"))

    def import_january(self, text=HEADER + ROW, source="VIIRS_SNPP_SP"):
        return history.import_csv(self.data, [text], source, datetime(2026, 1, 1, tzinfo=UTC),
                                  datetime(2026, 2, 1, tzinfo=UTC), NOW)

    def test_unknown_is_distinct_from_zero_detections_with_coverage(self):
        failures = tuple(history.SOURCES)
        unknown = self.update(snapshot(failures=failures))[2026]
        self.assertEqual(unknown["features"], [])
        self.assertTrue(all(not source["coverage"] for source in unknown["sources"]))
        self.assertIsNone(unknown["confirmed_fires"])
        observed_zero = self.update()[2026]
        self.assertEqual(observed_zero["features"], [])
        self.assertTrue(all(len(source["coverage"]) == 1 for source in observed_zero["sources"]))
        self.assertEqual(observed_zero["sources"][0]["coverage"][0]["start"], "2026-10-04T15:00:00Z")
        self.assertIsNone(observed_zero["confirmed_fires"])

    def test_only_successful_sources_extend_coverage_and_stale_points_do_not_enter(self):
        self.update()
        next_day = NOW + timedelta(days=1)
        stale = feature(next_day, identifier="stale")
        stale["properties"]["stale"] = True
        result = self.update(snapshot(next_day, [stale], failures=("VIIRS_SNPP_NRT",)), next_day)[2026]
        self.assertEqual(result["features"], [])
        self.assertEqual(result["sources"][0]["coverage"][0]["end"], history.hotspots.iso(NOW))
        self.assertEqual(result["sources"][1]["coverage"][0]["end"], history.hotspots.iso(next_day))

    def test_overlapping_windows_merge_but_gaps_remain_visible(self):
        self.update()
        self.update(snapshot(NOW + timedelta(days=1)), NOW + timedelta(days=1))
        result = self.update(snapshot(NOW + timedelta(days=20)), NOW + timedelta(days=20))[2026]
        intervals = result["sources"][0]["coverage"]
        self.assertEqual(len(intervals), 2)
        self.assertEqual(intervals[0]["end"], history.hotspots.iso(NOW + timedelta(days=1)))
        self.assertEqual(intervals[1]["start"], history.hotspots.iso(NOW + timedelta(days=13)))

    def test_sp_replaces_nrt_preserves_id_and_later_nrt_cannot_downgrade(self):
        date = datetime(2026, 1, 15, 14, tzinfo=UTC)
        self.update(snapshot(date, [feature(date)]), date)
        upgraded = self.import_january()[2026]
        self.assertEqual(len(upgraded["features"]), 1)
        point = upgraded["features"][0]
        self.assertEqual(point["id"], "existing-id")
        self.assertEqual(point["properties"]["source"], "VIIRS_SNPP_SP")
        self.assertEqual(point["properties"]["product"], "sp")
        preserved = self.update(snapshot(date, [feature(date)]))[2026]["features"]
        self.assertEqual(len(preserved), 1)
        self.assertEqual(preserved[0]["properties"]["product"], "sp")

    def test_expired_observations_stay_in_history_and_old_year_file_stays_untouched(self):
        previous = datetime(2025, 8, 1, 12, tzinfo=UTC)
        self.update(snapshot(previous, [feature(previous)]), previous)
        old_path = self.data / "history-2025.json"
        original = old_path.read_bytes()
        self.import_january()
        result = self.update()[2026]
        self.assertEqual(result["features"][0]["properties"]["detected_at"], "2026-01-15T14:00:00Z")
        self.assertEqual(old_path.read_bytes(), original)

    def test_wita_year_boundary_partitions_points_and_clips_coverage(self):
        at = datetime(2026, 1, 1, 1, tzinfo=UTC)
        before = datetime(2025, 12, 31, 15, 59, tzinfo=UTC)
        after = before + timedelta(minutes=1)
        result = self.update(snapshot(at, [feature(before, identifier="old"), feature(after, identifier="new")]), at)
        self.assertEqual([point["id"] for point in result[2025]["features"]], ["old"])
        self.assertEqual([point["id"] for point in result[2026]["features"]], ["new"])
        self.assertEqual(result[2025]["sources"][0]["coverage"][0]["end"], "2025-12-31T16:00:00Z")
        self.assertEqual(result[2026]["sources"][0]["coverage"][0]["start"], "2025-12-31T16:00:00Z")

    def test_csv_import_exact_aoi_clipping_ignores_claimed_inside_flag_and_has_no_7day_cutoff(self):
        angled_outside = ROW.replace("117.215", "117.2033").replace("-.449", "-.4385")
        result = self.import_january(HEADER + ROW + ROW + angled_outside)[2026]
        self.assertEqual(len(result["features"]), 1)
        self.assertEqual(result["features"][0]["properties"]["detected_at"], "2026-01-15T14:00:00Z")
        self.assertEqual([len(source["coverage"]) for source in result["sources"]], [1, 0, 0])

    def test_invalid_csv_or_wrong_satellite_does_not_write_history(self):
        invalid = ["<html>Login page</html>", HEADER + ROW.replace(",N,h,", ",N20,h,"),
                   HEADER + ROW.replace("117.215", "nan"), HEADER + ROW.replace(",h,", ",85,")]
        for text in invalid:
            with self.subTest(text=text), self.assertRaises(ValueError):
                self.import_january(text)
        self.assertFalse(list(self.data.glob("history-*.json")))

    def test_invalid_saved_schema_is_not_silently_replaced(self):
        self.update()
        path = self.data / "history-2026.json"
        archive = self.archive()
        archive["schema_version"] = 99
        path.write_text(json.dumps(archive), encoding="utf-8")
        original = path.read_bytes()
        with self.assertRaises(ValueError):
            self.update()
        self.assertEqual(path.read_bytes(), original)

    def test_inconsistent_snapshot_or_bad_feature_leaves_existing_history_intact(self):
        self.update()
        path = self.data / "history-2026.json"
        original = path.read_bytes()
        wrong_version = snapshot()
        wrong_version["generated_at"] = "2026-10-10T00:00:00Z"
        bad_feature = snapshot(features=[{"properties": {"source": "VIIRS_SNPP_NRT"}}])
        duplicate_source = snapshot()
        duplicate_source["status"]["sources"].append(copy.deepcopy(duplicate_source["status"]["sources"][0]))
        for document in (wrong_version, bad_feature, duplicate_source):
            with self.subTest(document=document), self.assertRaises(ValueError):
                self.update(document)
            self.assertEqual(path.read_bytes(), original)

    def test_saved_snapshot_coverage_uses_original_window_not_invocation_time(self):
        result = self.update(snapshot(NOW - timedelta(days=20)))[2026]
        interval = result["sources"][0]["coverage"][0]
        self.assertEqual(interval["end"], history.hotspots.iso(NOW - timedelta(days=20)))
        self.assertEqual(interval["start"], history.hotspots.iso(NOW - timedelta(days=27)))

    def test_public_provenance_cannot_leak_local_path_or_download_token(self):
        self.assertEqual(history.safe_reference("https://firms.modaps.eosdis.nasa.gov/download/secret.zip?token=secret"), history.ARCHIVE_REFERENCE)
        for reference in ("C:/Users/private/file.csv", "https://evil.example/file.csv", "https://user:secret@firms.modaps.eosdis.nasa.gov/download/"):
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                history.safe_reference(reference)

    def test_science_archive_provenance_preserves_filename_and_rejects_wrong_sensor(self):
        reference = "sftp://fuoco.geog.umd.edu/data/VIIRS/C2/VNP14IMGML/VNP14IMGML.202601.C2.04.csv.gz"
        start, end = datetime(2026, 1, 1, tzinfo=UTC), datetime(2026, 2, 1, tzinfo=UTC)
        result = history.import_csv(self.data, [HEADER + ROW], "VIIRS_SNPP_SP", start, end, NOW, reference)[2026]
        interval = result["sources"][0]["coverage"][0]
        self.assertEqual(interval["reference"], reference)
        self.assertEqual(interval["documentation"], history.SCIENCE_DOCUMENTATION)
        with self.assertRaises(ValueError):
            history.import_csv(self.data, [HEADER], "VIIRS_NOAA20_SP", start, end, NOW, reference)
        for unsafe in (reference.replace("sftp://", "sftp://fire:burnt@"), reference + "?secret=yes", reference.replace("/VNP14IMGML/", "/VJ114IMGML/")):
            with self.subTest(reference=unsafe), self.assertRaises(ValueError):
                history.safe_reference(unsafe)


if __name__ == "__main__":
    unittest.main()
