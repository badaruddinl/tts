# TTS Workspace

This workspace is ready to generate TTS audio from text files.

## 1) One-time setup

```powershell
npm install
Copy-Item .env.example .env
```

## 2) Quick use (regular file)

Fill `text.txt`, then run:

```powershell
npm run tts -- --input text.txt --output result.mp3
```

Humanize mode (automatic per-segment rate/pitch/volume variation + prosody data):

```powershell
npm run tts -- --input text.txt --output result_humanize.mp3 --humanize true --humanize-intensity 0.55
```

Optional segment parallelism (faster humanize, higher CPU/network usage):

```powershell
npm run tts -- --input text.txt --output result_humanize.mp3 --humanize true --segment-concurrency 2
```

Hybrid prosody mode (base per-segment + phrase override + important-word boost) is enabled by default.  
Disable for A/B:

```powershell
npm run tts -- --input text.txt --output result_no_hybrid.mp3 --humanize true --hybrid-prosody false
```

Voice character controls (enabled by default in humanize mode):

```powershell
npm run tts -- --input text.txt --output result_humanize.mp3 --humanize true --voice-character true --voice-tone auto --speech-style auto
```

Disable if you want raw output without voice character shaping:

```powershell
npm run tts -- --input text.txt --output result_raw.mp3 --humanize true --voice-character false
```

Backend selection (default stays `edge`):

```powershell
npm run tts -- --input text.txt --output result.mp3 --backend edge
```

`local-lite` backend is available as adapter mode:

```powershell
$env:TTS_BACKEND='local-lite'
$env:TTS_LOCAL_LITE_CMD='piper'
$env:TTS_LOCAL_LITE_MODEL='models\\id_model.onnx'
npm run tts -- --input text.txt --output result_local_lite.mp3 --humanize true
```

Tone options (works for both `Ardi` and `Gadis`): `auto`, `deep`, `bright`, `clear`, `soft`, `off`  
Speech style options: `auto`, `narrative`, `relaxed`, `assertive`, `dramatic`, `emotional`

Auto-expressive is enabled by default (for example, plain "hai" can be rendered warmer/more expressive based on context).  
Disable it for fully neutral output:

```powershell
npm run tts -- --input text.txt --output result_neutral.mp3 --humanize true --auto-expressive false
```

Prosody limiter (human-like guardrail) is enabled by default in humanize mode.  
You can override it manually:

```powershell
npm run tts -- --input text.txt --output result_humanize.mp3 --humanize true --prosody-limiter true --prosody-limiter-strength 0.64
```

Choose a style profile:

```powershell
npm run tts -- --input text.txt --output mystery.mp3 --humanize true --style misteri
```

If `--style` is omitted, runtime now uses selected expression default from:
- `config/expression/defaults.json`

Optional per-phrase intent override directly in text:

```text
I smiled [intent=ceria:0.8]. Then the door opened by itself [intent=tegang:0.9].
```

Additional output:
- `result_humanize.prosody.json`

## 3) Local web app (no long request timeout)

Run:

```powershell
npm run web
```

Open:

`http://localhost:3030`

Notes:
- Web uses a `job queue` system (submit -> status polling), so the browser does not wait for one long request.
- Generated audio is stored in `outputs/`.
- Job logs are shown in UI, printed in terminal, and saved to `.tts-cache/jobs.log`.
- Voice list is loaded automatically from the engine (`/api/voices`) and selected with a dropdown.
- Style list is loaded from the active profile (`/api/styles`) and selected with a dropdown.
- Dedicated `Training` tab: choose `profile + style` and run benchmark without manual input text.
- `Rate`, `Pitch`, `Volume` in web use sliders for faster tuning.
- Includes `Humanize` toggle + `Humanize Intensity` slider (0..1).
- When `Humanize` is enabled, web also provides `Prosody JSON` download.
- You can submit feedback score + notes per job, stored in `data/training/feedback.ndjson`.
- Training data is also grouped per style in `data/training/styles/<style>/feedback.ndjson` and `jobs.ndjson`.
- Auto-train is enabled by default: once feedback is submitted, a new profile can be created and auto-applied (`TTS_AUTO_TRAIN=true`).
- Feedback also supports `Adjust Rate/Pitch/Volume` for ML policy training.
- Feedback schema supports advanced labels:
  - `intent_target`
  - `intensity_target`
  - `transition_note`
  - `voice_fit`

## 4) Offline profile training

Initial profile is in `config/profiles/v1.json`, and active profile pointer is in `config/profiles/active.json`.

Train a new profile from feedback:

```powershell
npm run train:profile -- --apply true
```

Automatic flow without manual command:
- Generate audio -> job data recorded in `data/training/jobs.ndjson`
- Submit feedback in UI -> server auto-trains (if enough feedback exists)
- Minimum feedback threshold is controlled by `TTS_AUTO_TRAIN_MIN_FEEDBACK`

## 5) ML Policy (higher accuracy)

Train ML policy model from feedback with adjust labels:

```powershell
npm run train:ml
```

Train for a specific style:

```powershell
npm run train:ml -- --style misteri
```

Model output:
- `models/prosody-policy-v1.json`

When `TTS_ML_POLICY=true`, humanize generation uses this model for per-segment correction.

Results:
- Creates new profile versions (`v2.json`, `v3.json`, etc.) in `config/profiles/`
- If `--apply true`, the new profile becomes active immediately

## 6) One-command self-training

Run end-to-end training pipeline with no manual steps:

```powershell
npm run train:self
```

Run with Python trainer backend for profile + ML policy steps:

```powershell
npm run train:self:py
```

Loop continuously until stopped manually (`Ctrl + C`):

```powershell
npm run py:train:self:py:loop
```

Automatically runs:
- Dedupe training data
- Enrich detailed style feedback
- Train a new profile + auto-apply active profile
- Train global ML policy (+ optional per-style)
- Generate benchmark for 2 default voices (`Ardi` + `Gadis`)
- Run expression quality suite (`tests/expressions`)
- Auto-select expression default style and save to `config/expression/defaults.json`
- Run auto-intonation selection (humanize intensity + auto-expressive candidates) and auto-apply best config
- Run expression A/B and auto-apply winner runtime defaults (`style + humanize intensity + hybrid + prosody limiter`)
- Run hybrid prosody A/B suite (`hybrid off` vs `hybrid on`)
- Run limiter strength selection (evaluated on suite metrics) and auto-apply the best value
- Train limiter policy from feedback (regression) and auto-apply predicted strength
- Generate final TTS automatically from `template.tts.txt` into `outputs/final.mp3`

Example options:

```powershell
npm run train:self -- --styles horor_intim,melankolis --intensity 0.9 --min-feedback 4
```

Optional expression flags:
- `--expression-eval false` to skip expression suite + default selection
- `--expression-strict true` to make quality gate failure stop the pipeline
- `--expression-dir tests/expressions` to use a custom expression test directory
- `--intonation-eval false` to skip auto-intonation selection
- `--intonation-intensities 0.45,0.55,0.64,0.72,0.8` to set intensity candidates
- `--intonation-auto-expressive true,false` to set auto-expressive candidates
- `--intonation-auto-expressive-off-margin 0.1` allow `auto-expressive=false` only if its score gain passes this margin
- `--expression-ab false` to skip expression A/B
- `--expression-ab-apply false` to run A/B but not auto-apply winner to runtime defaults
- `--expression-ab-intensity-a 0.4` A configuration humanize intensity
- `--expression-ab-intensity-b 0.7` B configuration humanize intensity
- `--hybrid-eval false` to skip hybrid A/B suite
- `--hybrid-ab-apply false` to run hybrid A/B but not auto-apply winner to runtime defaults
- `--hybrid-strict true` to stop pipeline if hybrid A/B step fails
- `--hybrid-eval-dir tests/expressions` to use custom hybrid test directory
- `--hybrid-style tegang` to set style evaluated in hybrid A/B
- `--limiter-eval false` to skip limiter strength evaluation
- `--limiter-strengths 0.5,0.58,0.64,0.7,0.78` to set limiter candidates
- `--limiter-train false` to skip limiter policy training
- `--limiter-policy-apply false` to skip applying predicted limiter strength
- `--voice-eval false` to skip voice character suite
- `--voice-strict true` to make voice suite gate failure stop the pipeline
- `--final-tts false` to skip auto-generate final TTS
- `--final-tts-input template.tts.txt` to change auto-generate input file
- `--final-tts-output outputs/final.mp3` to change auto-generate output file
- `--sleep-ms 2000` (loop mode) to set delay between rounds
- `--stop-on-error true` (loop mode) to stop loop if one round fails
- `--max-runs 1` (loop mode) to run finite loops (0 = infinite)

## 7) Auto vs Tag Override evaluation

Run intent/transition evaluation without generating audio:

```powershell
npm run eval:expression -- --input text_intent_test.txt --style tegang
```

Output:
- `outputs/auto_expression_eval.json`

Run the multi-case Indonesian suite:

```powershell
npm run eval:expression-suite -- --dir tests/expressions --style tegang
```

Expression A/B (compare two configs, useful for "lebih manusiawi"):

```powershell
npm run eval:expression-ab -- --dir tests/expressions --style-a tegang --style-b tegang --intensity-a 0.4 --intensity-b 0.7
```

Hybrid A/B runner (`hybrid-prosody off` vs `on`):

```powershell
npm run eval:hybrid-ab -- --dir tests/expressions --style tegang
```

A/B outputs:
- `outputs/eval_hybrid_ab/summary.json`
- `outputs/eval_hybrid_ab/summary.md`

Suite outputs:
- `outputs/eval_suite/summary.json`
- `outputs/eval_suite/summary.md`

You can also enforce quality gate thresholds:

```powershell
npm run eval:expression-suite -- --dir tests/expressions --style tegang --max-auto-delta 9.8 --max-override-delta 10.2 --min-avg-override-segments 0.8 --max-avg-changed-segments 1.6
```

Auto-select the best default style from multiple candidates:

```powershell
npm run eval:expression-select -- --dir tests/expressions --styles tegang,natural,sinematik,narator_tegas,melankolis
```

Selection output:
- `config/expression/defaults.json`

## 8) Voice Character Suite

Run dedicated validation for `speech_style` and `voice_tone` behavior:

```powershell
npm run eval:voice-suite -- --dir tests/voice --style tegang
```

Outputs:
- `outputs/voice_eval_suite/summary.json`
- `outputs/voice_eval_suite/summary.md`

## 9) Trainer benchmark (JS vs Python, spawn vs service)

Run benchmark:

```powershell
npm run bench:trainers -- --runs 5 --feedback-file data/training/splits/ml/train.ndjson
```

Stable sequential runner (recommended on Windows hosts with strict job-object policy):

```powershell
npm run bench:trainers:seq -- -Runs 5 -FeedbackFile data/training/splits/ml/train.ndjson
```

Outputs:
- `outputs/bench_trainers/report.json`
- `outputs/bench_trainers/report.md`
## 10) Host migration (Export/Import pack)

Export full training state into one zip:

```powershell
npm run pack:export
```

Optional include `.env`:

```powershell
npm run pack:export -- --include-env true
```

Import on another host:

```powershell
npm run pack:import -- --file backups/training-pack-YYYYMMDD-HHMMSS.zip
```

Import automatically creates backup of previous state in:
- `backups/pre-import-<timestamp>/`

## 11) Use template format (recommended)

Use `template.tts.txt` as a pattern:

- Optional header: `VOICE`, `RATE`, `PITCH`, `VOLUME`, `OUTPUT`
- Separate header and body using `---`
- Supported body markers:
- `[SCENE: Scene Name]` (not spoken)
- `[PAUSE_SHORT]`, `[PAUSE_MEDIUM]`, `[PAUSE_LONG]` (converted to natural pauses)

Render example:

```powershell
npm run tts -- --input template.tts.txt
```

## 12) Voice list

```powershell
npm run tts:voices
```

Examples of Indonesian voices:
- `id-ID-GadisNeural`
- `id-ID-ArdiNeural`
