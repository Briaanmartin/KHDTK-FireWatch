# KHDTK FireWatch — WebGIS Lempake

WebGIS **KHDTK Diklathut Fahutan Unmul Lempake** dengan batas dari berkas pengguna dan deteksi hotspot NASA FIRMS.

**Situs:** https://briaanmartin.github.io/KHDTK-FireWatch/

## Fitur

- Header merah dan peta interaktif Leaflet, peta jalan OpenStreetMap serta citra Esri World Imagery sebagai tampilan awal.
- Tampilan fokus pada AOI SHP: citra di luar poligon ditutup, pergeseran peta dibatasi di sekitar AOI, dan tombol Fokus AOI mengembalikan seluruh kawasan ke layar.
- NASA FIRMS VIIRS S-NPP, NOAA-20 dan NOAA-21, maksimum 7 hari berjalan. Peta, ringkasan, dan tabel menampilkan deteksi **di dalam AOI KHDTK saja**.
- Filter 24/48 jam/7 hari dan kepercayaan deteksi.
- Popup, tabel, jarak batas, waktu WITA, FRP dalam MW, ekspor CSV dan unduh GeoJSON.
- Sumber yang gagal dibedakan dari sumber yang berhasil tanpa deteksi. Catatan lama yang masih relevan dipertahankan dan ditandai.
- Bagian foto laporan lapangan: foto, waktu WITA, lokasi/blok, catatan, galeri perangkat, dan unduh laporan HTML beserta foto.

## Batas

`AOI KRUS.shp` dipakai sebagai poligon utama. CRS asal **DGN95 / UTM zone 50S (EPSG:23880)** ditransformasikan ke **WGS84 (EPSG:4326)** dengan urutan GeoJSON `[longitude, latitude]`. Luas geodesik **313,8291 ha**. Transformasi memiliki akurasi yang dilaporkan PROJ 1 m; itu bukan pernyataan akurasi survei sumber.

`KHDTK .kml` memuat poligon lebih besar, **598,7504 ha**, yang melingkupi SHP dan tetap disimpan sebagai data pembanding. Peta fokus pada batas SHP saja. Luas merupakan hasil perhitungan berkas, bukan penetapan resmi. Berkas asli tidak disalin ke repository. Metadata dan tiga penanda KML tersedia dalam `data/boundary-info.json`.

Konversi ulang (opsional; tidak diperlukan oleh situs atau updater):

```powershell
python -m pip install -r scripts/requirements-boundary.txt
python scripts/convert-boundary.py --help
```

## Data hotspot dan pembaruan

Updater memakai [unduhan publik NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/active_fire/) dari [katalog resmi](https://firms.modaps.eosdis.nasa.gov/api/active_fire_files/all?format=json), tanpa MAP_KEY atau rahasia di frontend. Feed CSV Asia Tenggara memuat VIIRS Collection 2 Near Real-Time. Snapshot menyimpan titik hingga 25 km dari SHP untuk konteks data, sedangkan antarmuka hanya menampilkan titik di dalam poligon. Titik disaring dengan jarak sferis terpendek ke poligon SHP (radius bumi 6371,0088 km), deduplikasi sensor/waktu/koordinat, dan waktu UTC.

```powershell
python scripts/update-hotspots.py
```

`data/hotspots.geojson` memuat titik dan status dalam satu snapshot atomik. `data/hotspots-status.json` adalah salinan metadata untuk operasional. Frontend menampilkan waktu pemeriksaan, waktu akuisisi, status setiap sumber, dan peringatan ketika pemeriksaan berumur lebih dari 6 jam. Tombol **Muat ulang data** mengambil snapshot terakhir di situs; pengunduhan NASA dijalankan di GitHub Actions.

Workflow **Update NASA FIRMS hotspots** berjalan setiap jam pada menit 23 UTC, serta dapat dijalankan manual di Actions → Run workflow. Jadwal GitHub Actions bersifat best effort dan dapat tertunda; GitHub dapat menonaktifkan jadwal repository publik yang tidak aktif selama 60 hari. Periksa waktu pemeriksaan pada situs jika data tampak lama.

Workflow **Deploy WebGIS to GitHub Pages** berjalan saat push ke `main`, manual, atau ketika workflow pembaruan selesai. Pemicu terakhir diperlukan karena commit `GITHUB_TOKEN` tidak memicu workflow push lainnya. Pada Settings → Pages, pilih **GitHub Actions**. Deploy hanya menyalin berkas frontend, data, dan vendor.

Setiap titik adalah deteksi anomali panas satelit, bukan konfirmasi kebakaran atau jumlah kejadian. Satu kejadian bisa menghasilkan banyak deteksi. Tidak ada deteksi bukan jaminan tidak ada kebakaran. Citra peta dasar bukan citra kebakaran langsung. Kepercayaan VIIRS `high/nominal/low` bukan tingkat bahaya.

## Foto laporan lapangan

Foto JPEG, PNG, atau WebP (maksimum 10 MB) dan catatan disimpan menggunakan IndexedDB di browser/perangkat yang dipakai. Laporan tidak dikirim ke server, repository, atau anggota tim. Gunakan unduh laporan HTML untuk menyimpan salinan beserta foto atau membagikannya sendiri. Data browser dapat hilang jika penyimpanan situs dihapus; lakukan ekspor untuk salinan arsip. Alamat localhost dan GitHub Pages mempunyai penyimpanan berbeda.

Galeri awal kosong. Tidak ada foto lapangan buatan atau foto contoh yang disajikan sebagai laporan nyata.

## Menjalankan dan menguji

Tidak perlu build frontend. Jalankan server HTTP dari root proyek (modul JavaScript dan GeoJSON memerlukan HTTP):

```powershell
python -m http.server 8000
# Buka http://localhost:8000
node --test tests/core.test.mjs
python -m unittest discover -s tests -p 'test_*.py'
```

Dependensi browser Leaflet 1.9.4 disimpan di `vendor/leaflet/` beserta lisensi BSD-2-Clause. Peta dasar memerlukan internet. Atribusi OpenStreetMap dan Esri ditampilkan pada peta; hotspot diatribusikan kepada NASA FIRMS / LANCE.
