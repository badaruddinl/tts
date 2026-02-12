# Spec Expression v1

Status: `frozen-v1` (baseline for point 1-2).  
Change policy: only non-breaking additions are allowed until point 3 starts.

## 1) Global Style (final)

Global style is used as the narrative emotion baseline. If the selected style is a global alias, the engine maps it to the following internal profile style:

- `natural` -> `natural`
- `santai` -> `natural`
- `calm` -> `natural`
- `neutral` -> `natural`
- `ceria` -> `dramatis`
- `cheerful` -> `dramatis`
- `happy` -> `dramatis`
- `tegang` -> `thriller`
- `tense` -> `thriller`
- `sedih` -> `melankolis`
- `sad` -> `melankolis`
- `misteri` -> `misteri`
- `mystery` -> `misteri`
- `horor_intim` -> `horor_intim`
- `pasrah` -> `pasrah`
- `narator_tegas` -> `narator_tegas`
- `tegas` -> `narator_tegas`
- `assertive` -> `narator_tegas`
- `sinematik` -> `sinematik`
- `cinematic` -> `sinematik`
- `datar` -> `datar`
- `flat` -> `datar`

## 2) Intent Lokal (final)

Local intent operates at segment/phrase level, with intensity `0.0..1.0`.

- `netral`: no additional emotional push
- `ceria`: warmer, lighter, optimistic
- `tegang`: restrained, alert, tense atmosphere
- `sedih`: slower, lower tone, reduced energy
- `kaget`: short burst, sudden rise
- `tegas`: instructive, firm, emphasis-heavy
- `marah`: high energy with lower tone
- `tenang`: de-escalates tension, stabilizes delivery

Accepted bilingual intent aliases:
- `neutral` -> `netral`
- `cheerful|happy|excited` -> `ceria`
- `tense|suspense|anxious` -> `tegang`
- `sad|sorrow` -> `sedih`
- `surprised|shock` -> `kaget`
- `assertive|firm` -> `tegas`
- `angry|anger` -> `marah`
- `calm|soothe` -> `tenang`

## 3) Operating Mode

- `full auto` (default): engine detects local intent from text per segment.
- `optional tag override`: user can override intent for specific segments with inline tags.
- Priority: `tag override` wins over auto-detection for tagged segments.

## 4) Tag Override Format

Supported tags:

- `[intent=ceria]`
- `[intent:tegang:0.9]`
- `[emo=sedih,0.7]`
- `[emotion=kaget]`

General format:

- `intent`: local intent name
- `intensity` optional: number `0..1`, default `1`

## 5) Layered Engine Architecture

- Layer 1 (baseline style): takes base `rate/pitch/volume` from active style profile.
- Layer 2 (intent detection): detects intent per segment from keywords + punctuation + style prior.
- Layer 3 (transition smoothing): applies light hysteresis so emotion changes do not sound abrupt.

## 6) Output Diagnostics

Each segment stores reason diagnostics:

- `intent`
- `intentIntensity`
- `intentSource` (`auto` or `tag_override`)
- `transition` (`steady`, `smoothed`, or `held`)

## 7) v1 Freeze Scope

Locked in this version:
- Global style alias mapping (ID/EN -> internal style key)
- Local intent set (`netral`, `ceria`, `tegang`, `sedih`, `kaget`, `tegas`, `marah`, `tenang`)
- Operating mode (`full auto` + optional `tag override`)
- Transition states (`steady`, `smoothed`, `held`)

Deferred to next phase (point 3+):
- Per-voice character presets (`Ardi`/`Gadis`)
- Post-processing for heavier `Ardi` voice
- Training schema expansion (`intent_target`, `intensity_target`, `transition_note`, `voice_fit`)

## 8) v1 Quality Gate

Default pass thresholds for `eval:expression-suite`:
- `avgAutoTransitionDelta <= 9.8`
- `avgOverrideTransitionDelta <= 10.2`
- `avgOverrideIntentSegments >= 0.8`
- `avgChangedIntentSegments <= 1.6`

Recommended command:

```powershell
npm run eval:expression-suite -- --dir tests/expressions --style tegang
```
