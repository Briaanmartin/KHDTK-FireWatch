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
- Riwayat tahunan dalam AOI: grafik bulanan, cakupan arsip per satelit, jumlah deteksi tersimpan, hari dengan deteksi, detail bulanan, dan ekspor CSV. Bulan tanpa arsip ditandai belum tersedia.
- Catatan pencegahan dan dampak karhutla tahun 2026 dengan tautan sumber resmi; informasi kegiatan tidak dihitung sebagai kejadian api dalam AOI.

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

## Riwayat tahunan

Bagian **Riwayat tahunan** menghitung deteksi yang benar-benar tersimpan di dalam AOI SHP, dengan kalender **WITA (UTC+8)**. Grafik membedakan bulan dengan arsip, bulan dengan arsip sebagian, bulan tanpa arsip, dan bulan yang belum berlangsung. Jumlah deteksi tersimpan tidak boleh diperlakukan sebagai total tahun berjalan apabila cakupan arsip belum lengkap. Satu deteksi juga bukan satu kejadian kebakaran.

`data/history-YYYY.json` menyimpan pengamatan, sumber, interval cakupan setiap satelit, dan sidik geometri batas. Workflow setiap jam menjalankan `scripts/history.py` setelah memperbarui feed tujuh hari. Pengamatan lama tetap tersimpan; kegagalan sumber tidak memperluas cakupan. Interval arsip menandakan periode produk yang berhasil diambil, bukan jaminan pengamatan bebas awan atau seluruh kejadian api terdeteksi. Statistik kejadian terkonfirmasi dan luas terbakar belum tersedia.

Pada 11 Oktober 2026, 17 berkas bulanan sains **VIIRS Collection 2** dari arsip University of Maryland telah dibaca hingga EOF/CRC dan diperiksa ukuran serta SHA-256-nya. NOAA-20 dan NOAA-21 mencakup Januari–Juni UTC; S-NPP mencakup Januari–April serta Juni UTC. Berkas Mei S-NPP tidak tersedia dengan identitas produk yang sesuai sehingga tidak dimasukkan. Dari 20.690.264 observasi global dalam berkas tersebut, **0 titik** berada di dalam AOI SHP. Ini hanya hasil pada arsip yang tersedia, bukan jumlah kebakaran sepanjang tahun.

[Metadata pengunduhan dan sumber setiap berkas](data/history-provenance-2026.json) menyimpan bukti cakupan, ukuran, checksum, serta jumlah baris. Petunjuk sumber tersedia dalam [panduan resmi VIIRS C2](https://ladsweb.modaps.eosdis.nasa.gov/archive/Document%20Archive/Science%20Data%20Product%20Documentation/VIIRS_C2_AF-375m_User_Guide_1.0.pdf). Awal Januari WITA delapan jam pertama belum tercakup oleh berkas Januari UTC, sementara akhir Juni UTC mencakup delapan jam pertama Juli WITA. Periode setelah arsip Juni dan sebelum snapshot NRT Oktober belum dilengkapi. Grafik mempertahankan seluruh celah ini; ekspor ringkasan bulanan memisahkan nilai nol dari nilai belum diketahui.

Untuk mengarsipkan snapshot yang sudah tersedia:

```powershell
python scripts/history.py --data-dir data
```

Untuk melengkapi celah periode, unduh CSV VIIRS dari [arsip NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/download/) dengan cakupan area yang meliputi seluruh AOI dan tanggal yang diketahui. Impor setiap sensor dan periode secara terpisah; waktu awal inklusif, waktu akhir eksklusif. Contoh berikut hanya ilustrasi perintah, bukan data yang disertakan:

```powershell
python scripts/history.py --data-dir data --csv arsip-noaa20.csv --source VIIRS_NOAA20_SP --coverage-start 2026-01-01T00:00:00Z --coverage-end 2026-02-01T00:00:00Z
```

Importer memeriksa kolom CSV, sensor, koordinat, waktu, dan poligon AOI. Hasil kosong hanya bermakna jika berkas memang mencakup seluruh AOI dan periode yang dinyatakan. Produk SP mengungguli NRT pada sensor, waktu, dan koordinat yang sama. Kredensial, berkas mentah, dan URL bertoken tidak diterbitkan. Publikasikan JSON hasil impor melalui commit/push biasa.

Catatan sumber publik tahun 2026 berasal dari [SRUK](https://srukindonesia.kemenlh.go.id/activity/3e83db60-2b7d-4f2b-bd34-827a1f65bfd7), [agenda pembagian masker Kelurahan Lempake](https://kel-lempake.samarindakota.go.id/agenda/kegiatan-pembagian-masker-kepada-masyarakat-akibat-dampak-asap-kebakaran-hutan-dan-lahan-IPCXD), dan [pengumuman pencegahan karhutla](https://kel-lempake.samarindakota.go.id/announcement/cegah-kebaran-hutan-dan-lahan-MKDCF), diperiksa 11 Oktober 2026. Catatan ini merupakan konteks program dan dampak, tidak menetapkan jumlah/lokasi kejadian atau luas terbakar dalam AOI.

## Foto laporan lapangan

Foto JPEG, PNG, atau WebP (maksimum 10 MB) dan catatan disimpan menggunakan IndexedDB di browser/perangkat yang dipakai. Laporan tidak dikirim ke server, repository, atau anggota tim. Gunakan unduh laporan HTML untuk menyimpan salinan beserta foto atau membagikannya sendiri. Data browser dapat hilang jika penyimpanan situs dihapus; lakukan ekspor untuk salinan arsip. Alamat localhost dan GitHub Pages mempunyai penyimpanan berbeda.

Galeri awal kosong. Tidak ada foto lapangan buatan atau foto contoh yang disajikan sebagai laporan nyata.

## Menjalankan dan menguji

Tidak perlu build frontend. Jalankan server HTTP dari root proyek (modul JavaScript dan GeoJSON memerlukan HTTP):

```powershell
python -m http.server 8000
# Buka http://localhost:8000
node --test tests/*.test.mjs
python -m unittest discover -s tests -p 'test_*.py'
```

Dependensi browser Leaflet 1.9.4 disimpan di `vendor/leaflet/` beserta lisensi BSD-2-Clause. Peta dasar memerlukan internet. Atribusi OpenStreetMap dan Esri ditampilkan pada peta; hotspot diatribusikan kepada NASA FIRMS / LANCE.
