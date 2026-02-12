# TTS Workspace

Workspace ini sudah siap untuk generate audio TTS dari file teks.

## 1) Setup sekali

```powershell
npm install
Copy-Item .env.example .env
```

## 2) Pakai cepat (file biasa)

Isi `text.txt`, lalu jalankan:

```powershell
npm run tts -- --input text.txt --output hasil.mp3
```

Mode humanize (variasi rate/pitch/volume otomatis per segmen + data prosody):

```powershell
npm run tts -- --input text.txt --output hasil_humanize.mp3 --humanize true --humanize-intensity 0.55
```

Pilih style profile:

```powershell
npm run tts -- --input text.txt --output misteri.mp3 --humanize true --style misteri
```

Output tambahan:
- `hasil_humanize.prosody.json`

## 3) Web lokal (tanpa request timeout panjang)

Jalankan:

```powershell
npm run web
```

Buka:

`http://localhost:3030`

Catatan:
- Web memakai sistem `job queue` (submit -> polling status), jadi browser tidak menunggu satu request panjang.
- Hasil audio disimpan di folder `outputs/`.
- Log job tampil di UI, tercetak di terminal, dan disimpan ke `.tts-cache/jobs.log`.
- Voice diambil otomatis dari engine (`/api/voices`) dan dipilih lewat dropdown.
- Style diambil dari profile aktif (`/api/styles`) dan dipilih lewat dropdown.
- Ada tab `Training` khusus: pilih `profile + style` lalu jalankan benchmark tanpa input text.
- `Rate`, `Pitch`, `Volume` di web memakai slider agar tuning cepat.
- Ada toggle `Humanize` + slider `Humanize Intensity` (0..1).
- Saat `Humanize` aktif, web juga menyediakan download `Prosody JSON`.
- Feedback score + catatan bisa dikirim per job, disimpan di `data/training/feedback.ndjson`.
- Data training juga dikelompokkan per style di `data/training/styles/<style>/feedback.ndjson` dan `jobs.ndjson`.
- Auto-train aktif default: setelah feedback masuk, profile baru bisa terbuat dan langsung di-apply otomatis (`TTS_AUTO_TRAIN=true`).
- Feedback juga punya `Adjust Rate/Pitch/Volume` untuk melatih model ML policy.

## 4) Training Offline Profile

Profile awal ada di `config/profiles/v1.json` dan profile aktif diset di `config/profiles/active.json`.

Latih profile baru dari feedback:

```powershell
npm run train:profile -- --apply true
```

Otomatis tanpa command manual:
- Generate audio -> data job tercatat ke `data/training/jobs.ndjson`
- Kirim feedback di UI -> server auto-train (jika feedback cukup)
- Batas minimal feedback diatur lewat `TTS_AUTO_TRAIN_MIN_FEEDBACK`

## 5) ML Policy (lebih akurat)

Latih model ML policy dari feedback berlabel adjust:

```powershell
npm run train:ml
```

Latih khusus style tertentu:

```powershell
npm run train:ml -- --style misteri
```

Output model:
- `models/prosody-policy-v1.json`

Saat `TTS_ML_POLICY=true`, generate humanize akan memakai model ini untuk koreksi per segmen.

Hasil:
- Membuat profile versi baru (`v2.json`, `v3.json`, dst) di `config/profiles/`
- Jika `--apply true`, profile baru langsung jadi active profile

## 6) Migrasi Host (Export/Import Pack)

Export semua state training ke 1 zip:

```powershell
npm run pack:export
```

Opsional include `.env`:

```powershell
npm run pack:export -- --include-env true
```

Import di host lain:

```powershell
npm run pack:import -- --file backups/training-pack-YYYYMMDD-HHMMSS.zip
```

Import otomatis membuat backup state lama di:
- `backups/pre-import-<timestamp>/`

## 7) Pakai format template (disarankan)

Gunakan `template.tts.txt` sebagai pola:

- Header opsional: `VOICE`, `RATE`, `PITCH`, `VOLUME`, `OUTPUT`
- Batasi header dan body dengan `---`
- Marker yang didukung di body:
- `[SCENE: Nama Adegan]` (tidak dibacakan)
- `[PAUSE_SHORT]`, `[PAUSE_MEDIUM]`, `[PAUSE_LONG]` (diubah jadi jeda alami)

Contoh render:

```powershell
npm run tts -- --input template.tts.txt
```

## 8) Voice list

```powershell
npm run tts:voices
```

Contoh voice Indonesia:

- `id-ID-GadisNeural`
- `id-ID-ArdiNeural`
