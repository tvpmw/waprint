# WhatsApp Print Server Bot

**WhatsApp Print Server Bot** adalah bot WhatsApp yang memungkinkan Anda mencetak dokumen langsung dari WhatsApp ke printer lokal. Bot ini mendukung berbagai format file, antrian print, estimasi biaya, opsi print (duplex, kualitas, kertas), serta fitur admin dan statistik.

---

## ✨ Fitur Utama

- Kirim file (PDF, DOC, JPG, PNG, TXT) via WhatsApp untuk dicetak otomatis
- Deteksi jumlah halaman & warna dokumen
- Estimasi biaya print
- Opsi print: jumlah salinan, kualitas, ukuran kertas, duplex
- Antrian print & riwayat pengguna
- Statistik penggunaan & log sistem
- Kontrol admin (broadcast, cek printer, test print, dll)
- Rate limiting & keamanan akses

---

## 🚀 Cara Install

1. **Clone repository & masuk folder**
   ```
   git clone <repo-url>
   cd waprint
   ```

2. **Install dependencies**
   ```
   npm install
   ```

3. **Jalankan setup wizard**
   ```
   npm run setup
   ```
   Wizard akan membuat folder `logs/`, `temp/`, dan file [`config.json`](waprint/bot.js ).

---

## ⚙️ Setup & Konfigurasi

1. **Edit file [`config.json`](waprint/bot.js )**  
   - Atur nama printer ([`printSettings.printerName`](waprint/bot.js ))
   - Tambahkan nomor admin di [`bot.adminNumbers`](waprint/bot.js )
   - Atur format file yang diizinkan, batas ukuran, dsb

2. **Pastikan printer sudah terinstall & terhubung ke komputer/server**

3. **Jalankan bot**
   ```
   npm start
   ```
   atau untuk development:
   ```
   npm run dev
   ```

4. **Scan QR Code**  
   Saat pertama kali dijalankan, scan QR Code dengan WhatsApp Anda.

---

## 📱 Cara Menggunakan

1. **Kirim file ke bot WhatsApp**  
   Format yang didukung: PDF, DOC, JPG, PNG, TXT (bisa diatur di config)

2. **Bot akan analisis file & menampilkan info print**  
   Termasuk jumlah halaman, warna, estimasi biaya, dll.

3. **Konfirmasi print**  
   Balas dengan `YA` untuk mencetak, atau `OPSI` untuk mengatur opsi print (jumlah salinan, kualitas, kertas, duplex).

4. **Ambil hasil print di printer**  
   Bot akan memberi notifikasi jika print selesai.

---

## 💡 Perintah Bot

- `/help` — Bantuan lengkap
- `/status` — Status printer & sistem
- `/queue` — Lihat antrian print
- `/cancel` — Batalkan print job
- `/history` — Riwayat print Anda
- `/formats` — Format file yang didukung
- `/ping` — Test koneksi bot

**Admin Command:**
- `/admin stats` — Statistik sistem
- `/admin users` — Data pengguna
- `/admin queue` — Detail antrian
- `/admin printer check` — Cek printer
- `/admin printer test` — Test print
- `/admin config` — Info konfigurasi
- `/admin logs` — Log sistem
- `/admin broadcast <pesan>` — Broadcast ke user aktif

---

## 📝 Log & Monitoring

- Log harian tersimpan di folder `logs/`
- Statistik penggunaan di `logs/stats.json`
- Riwayat print otomatis dibersihkan & log dirotasi

---

## 🖨️ Tips Produksi

- Jalankan dengan [PM2](https://pm2.keymetrics.io/) untuk production:
  ```
  npm install -g pm2
  pm2 start bot.js
  ```
- Monitor log:
  ```
  tail -f logs/bot-YYYY-MM-DD.log
  ```

---

## ❓ FAQ

- **Q:** Printer tidak terdeteksi?  
  **A:** Pastikan printer sudah terinstall & online. Jalankan setup wizard untuk cek printer.

- **Q:** Tidak bisa print file tertentu?  
  **A:** Cek format & ukuran file. Edit [`config.json`](waprint/bot.js ) jika perlu.

---

## 📄 Lisensi

MIT License

---

**Kontribusi & saran sangat diterima!**  
Powered by Enhanced WhatsApp Print Bot.