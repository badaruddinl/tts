import json
import os
from datetime import datetime, timezone
from pathlib import Path

from common_pipeline import parse_args


def to_num(v, fallback=0.0):
    try:
        n = float(v)
        if n == n and n not in (float("inf"), float("-inf")):
            return n
    except Exception:
        pass
    return fallback


def clamp(n, lo, hi):
    return max(lo, min(hi, n))


def parse_signed_rate(value, fallback="-8%"):
    raw = str(value or "").strip()
    if not raw:
        return fallback
    if raw.endswith("%"):
        return raw
    n = int(round(to_num(raw, 0.0)))
    return f"{n:+d}%"


def parse_signed_pitch(value, fallback="-2Hz"):
    raw = str(value or "").strip()
    if not raw:
        return fallback
    if raw.lower().endswith("hz"):
        return raw
    n = int(round(to_num(raw, 0.0)))
    return f"{n:+d}Hz"


def parse_signed_volume(value, fallback="0%"):
    raw = str(value or "").strip()
    if not raw:
        return fallback
    if raw.endswith("%"):
        return raw
    n = int(round(to_num(raw, 0.0)))
    return f"{n:+d}%"


def load_json(path_obj):
    p = Path(path_obj).resolve()
    if not p.exists():
        return {}
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def avg(items):
    return (sum(items) / len(items)) if items else 0.0


def summarize_segments(segments):
    rows = segments if isinstance(segments, list) else []
    rates = []
    pitches = []
    volumes = []
    for seg in rows:
        base = seg.get("final") if isinstance(seg.get("final"), dict) else seg
        rates.append(to_num(base.get("rate"), 0.0))
        pitches.append(to_num(base.get("pitch"), 0.0))
        volumes.append(to_num(base.get("volume"), 0.0))
    return {
        "segmentCount": len(rows),
        "avgRate": round(avg(rates), 3),
        "avgPitch": round(avg(pitches), 3),
        "avgVolume": round(avg(volumes), 3),
    }


def resolve_profile_style(sample_style):
    profile_dir = Path("config/profiles")
    active = profile_dir / "active.json"
    selected = "v1.json"
    if active.exists():
        try:
            with open(active, "r", encoding="utf-8") as f:
                selected = str((json.load(f) or {}).get("activeProfile") or selected)
        except Exception:
            pass
    profile_path = profile_dir / selected
    if not profile_path.exists():
        return {"style": sample_style or "natural", "fallback": False}
    try:
        with open(profile_path, "r", encoding="utf-8") as f:
            prof = json.load(f) or {}
        styles = prof.get("styles") if isinstance(prof, dict) else {}
        styles = styles if isinstance(styles, dict) else {}
        default_style = str(prof.get("defaultStyle") or "natural")
        if sample_style and sample_style in styles:
            return {"style": sample_style, "fallback": False}
        return {"style": default_style, "fallback": True}
    except Exception:
        return {"style": sample_style or "natural", "fallback": False}


def main():
    args = parse_args(os.sys.argv[1:])
    sample_arg = str(args.get("sample") or "").strip()
    if sample_arg:
        sample_path = Path(sample_arg).resolve()
    else:
        root_sample = Path("sample_text.json").resolve()
        nested_sample = Path("sample/sample_text.json").resolve()
        sample_path = root_sample if root_sample.exists() else nested_sample
    config_path = Path(str(args.get("config") or "config/expression/defaults.json")).resolve()
    if not sample_path.exists():
        raise RuntimeError(f"sample_not_found={sample_path}")

    sample = load_json(sample_path)
    defaults = load_json(config_path) if config_path.exists() else {}

    raw_style = str(sample.get("style") or "natural").strip() or "natural"
    style_res = resolve_profile_style(raw_style)
    style = style_res["style"]
    humanize_intensity = clamp(to_num(sample.get("humanizeIntensity"), 0.55), 0.0, 1.0)
    hybrid = bool(sample.get("hybridProsody", True))
    limiter_cfg = sample.get("prosodyLimiter") if isinstance(sample.get("prosodyLimiter"), dict) else {}
    limiter_enabled = bool(limiter_cfg.get("enabled", True))
    limiter_strength = clamp(to_num(limiter_cfg.get("strength"), 0.64), 0.3, 1.0)
    voice_cfg = sample.get("voiceCharacter") if isinstance(sample.get("voiceCharacter"), dict) else {}
    speech_style = str(voice_cfg.get("speechStyle") or "auto").strip() or "auto"
    voice_tone = str(voice_cfg.get("voiceTone") or "auto").strip() or "auto"
    base_cfg = sample.get("base") if isinstance(sample.get("base"), dict) else {}
    base_rate = parse_signed_rate(base_cfg.get("rate"), fallback="-8%")
    base_pitch = parse_signed_pitch(base_cfg.get("pitch"), fallback="-2Hz")
    base_volume = parse_signed_volume(base_cfg.get("volume"), fallback="0%")
    auto_expressive = bool((sample.get("mlPolicy") or {}).get("enabled", True))

    segment_stats = summarize_segments(sample.get("segments"))
    now = datetime.now(timezone.utc).isoformat()
    defaults["updatedAt"] = now
    lock_profile_from_sample = str(args.get("lock-profile-from-sample") or "false").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    selected_profile = (
        str(sample.get("profileFile") or "").strip() or "active"
        if lock_profile_from_sample
        else "active"
    )

    defaults["selectedRuntime"] = {
        "source": "sample_tuning",
        "sampleFile": str(sample_path.relative_to(Path.cwd())).replace("\\", "/"),
        "sampleLock": True,
        "forceHumanize": True,
        "style": style,
        "sampleStyle": raw_style,
        "sampleStyleFallback": bool(style_res["fallback"]),
        "profileFile": selected_profile,
        "humanizeIntensity": humanize_intensity,
        "autoExpressive": auto_expressive,
        "hybridProsody": hybrid,
        "prosodyLimiter": {"enabled": limiter_enabled, "strength": round(float(limiter_strength), 3)},
        "voiceCharacter": {"speechStyle": speech_style, "voiceTone": voice_tone},
        "base": {"rate": base_rate, "pitch": base_pitch, "volume": base_volume},
        "sampleStats": segment_stats,
    }
    config_path.parent.mkdir(parents=True, exist_ok=True)
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(defaults, f, indent=2, ensure_ascii=False)
    print(
        f"sample_tuning_applied style={style} sample_style={raw_style} fallback={str(style_res['fallback']).lower()} intensity={humanize_intensity} "
        f"hybrid={str(hybrid).lower()} limiter={limiter_strength:.3f} "
        f"speech_style={speech_style} voice_tone={voice_tone} "
        f"base={base_rate},{base_pitch},{base_volume} segments={segment_stats['segmentCount']}"
    )


if __name__ == "__main__":
    main()
