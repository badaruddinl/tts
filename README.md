# TTS Workspace

Workspace ini memakai Python untuk runtime TTS + train/eval ML, dan Node untuk web app.

## 1) Setup

```powershell
npm install
Copy-Item .env.example .env
pip install edge-tts
```

## 2) Generate TTS

```powershell
npm run tts -- --input text.txt --output result.mp3
```

Catatan:
- `npm run tts` sekarang jalur Python native (`scripts_py/generate_tts.py`).
- Jalur lama Node tetap ada di `npm run js:tts`.
- Jika `edge-tts` Python belum terpasang, pakai fallback: `npm run py:tts -- --runtime auto ...`.

Humanize:

```powershell
npm run tts -- --input text.txt --output result_humanize.mp3 --humanize true --humanize-intensity 0.55
```

Auto punctuate + rewrite (sebelum prosody):

```powershell
npm run tts -- --input text.txt --output result_humanize.mp3 --humanize true --auto-punctuate true --text-rewrite true
```

Mode auto punctuate:

- `--auto-punctuate-mode conservative` (aman, minim perubahan)
- `--auto-punctuate-mode balanced` (default)
- `--auto-punctuate-mode aggressive` (lebih banyak tanda baca)

Audio-only (tanpa prosody file):

```powershell
npm run tts -- --input text.txt --output result_humanize.mp3 --humanize true --mode prod --save-prosody false
```

## 3) Web App

```powershell
npm run web
```

Open: `http://localhost:3030`

Catatan:
- Training write default ke SQLite (`data/training/training.db`).
- Jika mau mirror NDJSON lagi: `TTS_NDJSON_TRAINING=true`.
- Runtime config source default `auto` (SQLite-first). Force file: `TTS_CONFIG_SOURCE=file`.

## 4) SQLite Migration

```powershell
npm run py:train:migrate-sqlite
```

Ini mengisi SQLite dari source training/artifact yang tersedia.

## 5) Python ML Training

Train profile:

```powershell
npm run train:profile -- --apply true
```

Train ML policy:

```powershell
npm run train:ml
```

Train limiter policy:

```powershell
npm run train:limiter-policy
```

Unified DB trainer:

```powershell
npm run py:train:db
```

## 6) Python Eval (Human-like)

Expression suite:

```powershell
npm run eval:expression-suite -- --dir tests/expressions --style tegang
```

Expression A/B:

```powershell
npm run eval:expression-ab -- --dir tests/expressions --style-a tegang --style-b tegang --intensity-a 0.4 --intensity-b 0.7
```

Hybrid A/B:

```powershell
npm run eval:hybrid-ab -- --dir tests/expressions --style tegang
```

Select intonation:

```powershell
npm run eval:intonation:select -- --dir tests/expressions --style tegang
```

Select limiter:

```powershell
npm run eval:limiter:select -- --dir tests/expressions --style tegang
```

Voice suite:

```powershell
npm run eval:voice-suite -- --dir tests/voice --style tegang
```

Prosody parity (JS vs PY contract):

```powershell
npm run py:eval:prosody-parity
```

Level parity:

```powershell
npm run py:eval:prosody-parity:mid
npm run py:eval:prosody-parity:strict
```

Reference match terhadap `sample/training_audio.m4a`:

```powershell
npm run eval:reference-match
```

`prod:eval` sekarang pakai parity level `strict` (`tolerance=2`).

Jika butuh baseline longgar:

```powershell
npm run prod:eval:base
```

Untuk gate lebih ketat:

```powershell
npm run prod:eval:mid
npm run prod:eval:strict
```

CI/local quality gate:

```powershell
npm run ci:quality-gate
```

## 7) Self-Train (Python + SQLite)

```powershell
npm run train:self
```

Loop mode:

```powershell
npm run train:self:loop
```

Self-train akan log run eval/training ke SQLite (`training_runs`, `metrics`, `recommendations`).

## 8) Export / Import Pack (Python)

Export:

```powershell
npm run pack:export
```

Import:

```powershell
npm run pack:import -- --file backups/training-pack-YYYYMMDD-HHMMSS.zip
```

## 9) Strict Production Commands

Train semua model dari SQLite:

```powershell
npm run prod:train
```

Jalankan eval utama:

```powershell
npm run prod:eval
```

Apply default runtime dari hasil eval/policy:

```powershell
npm run prod:apply
```

Pipeline penuh (train + eval + apply):

```powershell
npm run prod:pipeline
```

## 10) Voice List

```powershell
npm run tts:voices
```

## 11) Quality Gate (Manual QA)

Gunakan:

- `config/training/quality-gate.md` untuk rule lulus/gagal.
- `config/training/quality-gate-run-template.md` untuk log penilaian tiap run.

## 12) Apply Tuning From Sample

Jika kamu punya referensi prosody di `sample/sample_text.json`, apply ke runtime defaults:

```powershell
npm run tuning:apply:sample
```

Setelah ini, runtime TTS akan lock ke tuning sample secara default.
Jika mau bypass sementara:

```powershell
npm run tts -- --input template.tts.txt --output outputs/final.mp3 --unlock-sample true
```

Catatan: bypass hanya aktif jika `TTS_ALLOW_SAMPLE_UNLOCK=true`.

## 13) Google Colab

Notebook siap pakai:

- `colab/tts_tuning_colab.ipynb`
