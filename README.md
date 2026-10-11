# KHDTK FireWatch

Dashboard statis berbahasa Indonesia untuk prototipe pemantauan titik panas Kawasan Hutan dengan Tujuan Khusus.

**Semua data dan peta adalah ilustrasi. Aplikasi belum terhubung ke sumber satelit, batas kawasan resmi, atau layanan darurat.** Kepercayaan deteksi bukan tingkat bahaya kebakaran.

## Fitur
- Ringkasan titik panas dan kepercayaan tinggi mengikuti filter.
- Filter kawasan, tingkat kepercayaan, dan pencarian ID.
- Peta skematis, tabel catatan, ekspor CSV hasil filter.
- Tata letak responsif, tanpa dependensi eksternal.

## Menjalankan
Buka `index.html`, atau jalankan `python -m http.server 8000` lalu buka http://localhost:8000.

## GitHub Pages
Pada repository `briaanmartin/KHDTK-FireWatch`, buka Settings → Pages. Pilih **Deploy from a branch**, branch **main**, folder **/(root)**, lalu Save.

Alamat yang diharapkan: https://briaanmartin.github.io/KHDTK-FireWatch/

## Menghubungkan data aktual
Ganti dataset di `app.js` setelah sumber, izin penggunaan, cakupan KHDTK, dan waktu pembaruan ditentukan. Jangan memasukkan API key ke JavaScript publik. Integrasi yang memerlukan rahasia harus melalui backend atau proses pengambilan data di server.
