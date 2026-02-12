# Spec Voice Character v1

Status: `active`.

## Scope

- Preset tone per voice key (`ardi`, `gadis`) per style.
- Local post-processing for both voices after TTS concat.
- Speech style control for delivery mode (`narrative`, `relaxed`, `assertive`, etc.).

## Config

- File: `config/voice-character/presets.json`
- Resolution:
1. Resolve style from active expression style (`thriller`, `melankolis`, etc.).
2. Resolve voice key from voice name:
   - contains `ArdiNeural` -> `ardi`
   - contains `GadisNeural` -> `gadis`
3. Apply style+voice preset (`base`, `amplitudeMul`, `post`).

## Runtime Behavior

- Prosody layer applies preset:
  - `base`: additive offsets to `rate/pitch/volume`
  - `amplitudeMul`: multiplier for wave amplitude dynamics
- Post-processing (voice tone):
  - Applied after final MP3 concat.
  - Uses ffmpeg filter chain (`EQ + compressor`) with selectable tone profile:
    - `deep`
    - `bright`
    - `clear`
    - `soft`
    - `auto` (from preset)
    - `off` (disabled)

## Controls

- CLI flags:
  - `--voice-character true|false`
  - `--voice-tone auto|deep|bright|clear|soft|off`
  - `--speech-style auto|narrative|relaxed|assertive|dramatic|emotional`
- Environment:
  - `TTS_VOICE_CHARACTER`
  - `TTS_VOICE_TONE`
  - `TTS_SPEECH_STYLE`
