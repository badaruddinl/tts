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
- `Rate`, `Pitch`, `Volume` di web memakai slider agar tuning cepat.

## 4) Pakai format template (disarankan)

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

## 5) Voice list

```powershell
npm run tts:voices
```

Contoh voice Indonesia:

- `id-ID-GadisNeural`
- `id-ID-ArdiNeural`
