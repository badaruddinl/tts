# TTS Workspace

Workspace ini memakai Node untuk runtime TTS/web, dan Python untuk semua train/eval ML.

## 1) Setup

```powershell
npm install
Copy-Item .env.example .env
```

## 2) Generate TTS

```powershell
npm run tts -- --input text.txt --output result.mp3
```

Humanize:

```powershell
npm run tts -- --input text.txt --output result_humanize.mp3 --humanize true --humanize-intensity 0.55
```

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

## 9) Voice List

```powershell
npm run tts:voices
```
