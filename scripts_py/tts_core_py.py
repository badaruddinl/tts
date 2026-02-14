import asyncio
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from common_pipeline import to_bool

try:
    import edge_tts
except Exception:
    edge_tts = None


META_KEYS = {"TITLE", "VOICE", "RATE", "PITCH", "VOLUME", "OUTPUT"}
TEXT_LEXICON_PATH = Path("config/text/lexicon.json")
DEFAULTS_PATH = Path("config/expression/defaults.json")
PROFILE_DIR = Path("config/profiles")
POLICY_MODEL_PATH = Path("models/prosody-policy-v1.json")


GLOBAL_STYLE_ALIASES = {
    "natural": "natural",
    "santai": "natural",
    "calm": "natural",
    "netral": "natural",
    "neutral": "natural",
    "ceria": "dramatis",
    "cheerful": "dramatis",
    "happy": "dramatis",
    "energetic": "dramatis",
    "tegang": "thriller",
    "tense": "thriller",
    "thriller": "thriller",
    "dramatic_tense": "thriller",
    "sedih": "melankolis",
    "sad": "melankolis",
    "melancholic": "melankolis",
    "misteri": "misteri",
    "mystery": "misteri",
    "horror_intimate": "horor_intim",
    "intimate_horror": "horor_intim",
    "tegas": "narator_tegas",
    "assertive": "narator_tegas",
    "cinematic": "sinematik",
    "flat": "datar",
}


STYLE_INTENT_PRIOR = {
    "natural": "netral",
    "datar": "netral",
    "dramatis": "ceria",
    "misteri": "tegang",
    "thriller": "tegang",
    "horor_intim": "tegang",
    "melankolis": "sedih",
    "pasrah": "sedih",
    "narator_tegas": "tegas",
    "sinematik": "tegang",
}


INTENT_PROSODY = {
    "netral": {"rate": 0.0, "pitch": 0.0, "volume": 0.0},
    "ceria": {"rate": 1.5, "pitch": 2.1, "volume": 0.8},
    "tegang": {"rate": -0.9, "pitch": -0.8, "volume": 0.5},
    "sedih": {"rate": -1.7, "pitch": -1.5, "volume": -0.9},
    "kaget": {"rate": 2.1, "pitch": 2.4, "volume": 1.4},
    "tegas": {"rate": 0.8, "pitch": -0.5, "volume": 1.2},
    "marah": {"rate": 1.4, "pitch": -1.0, "volume": 1.6},
    "tenang": {"rate": -0.8, "pitch": -0.2, "volume": -0.3},
}


INTENT_PATTERNS = {
    "ceria": re.compile(
        r"\b(asyik|senang|bahagia|akhirnya|mantap|hebat|seru|keren|yes|yey|hore|wow|great|awesome|finally)\b",
        re.I,
    ),
    "tegang": re.compile(
        r"\b(gelap|langkah|pintu|bayangan|bisik|takut|mencekam|sunyi|merinding|dark|shadow|whisper|afraid|cold)\b",
        re.I,
    ),
    "sedih": re.compile(
        r"\b(sedih|kecewa|hampa|lelah|menangis|sendiri|pilu|terluka|heartbroken|lonely|exhausted|grief)\b",
        re.I,
    ),
    "kaget": re.compile(r"\b(kaget|astaga|waduh|tidak mungkin|what|hah|oh no|no way|suddenly)\b", re.I),
    "tegas": re.compile(r"\b(dengar|perhatikan|ingat|harus|wajib|sekarang|fokus|listen|must)\b", re.I),
    "marah": re.compile(r"\b(marah|geram|kesal|muak|benci|angry|furious|annoyed|hate)\b", re.I),
    "tenang": re.compile(r"\b(pelan|tenang|tarik napas|damai|aman|breathe|steady|calm down|relax)\b", re.I),
}

SPEECH_STYLE_PRESETS = {
    "auto": {"base": {"rate": 0.0, "pitch": 0.0, "volume": 0.0}, "amp": {"rate": 1.0, "pitch": 1.0, "volume": 1.0}},
    "narrative": {"base": {"rate": 0.0, "pitch": 0.0, "volume": 0.0}, "amp": {"rate": 1.02, "pitch": 1.01, "volume": 1.01}},
    "relaxed": {"base": {"rate": -1.2, "pitch": -0.3, "volume": -0.2}, "amp": {"rate": 0.9, "pitch": 0.9, "volume": 0.95}},
    "assertive": {"base": {"rate": 0.7, "pitch": -0.4, "volume": 0.8}, "amp": {"rate": 1.05, "pitch": 0.95, "volume": 1.08}},
    "dramatic": {"base": {"rate": 0.2, "pitch": 0.6, "volume": 0.5}, "amp": {"rate": 1.14, "pitch": 1.15, "volume": 1.1}},
    "emotional": {"base": {"rate": -0.2, "pitch": 0.8, "volume": 0.4}, "amp": {"rate": 1.1, "pitch": 1.18, "volume": 1.08}},
}


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def to_num(value, fallback=0.0):
    try:
        n = float(value)
        if math.isfinite(n):
            return n
    except Exception:
        pass
    return fallback


def parse_percent_number(value, fallback=0.0):
    return to_num(str(value or "").replace("%", "").strip(), fallback)


def parse_hz_number(value, fallback=0.0):
    return to_num(str(value or "").replace("Hz", "").strip(), fallback)


def read_json_file(path_obj):
    p = Path(path_obj)
    if not p.exists():
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def clean_line(line):
    out = str(line or "").strip()
    if not out:
        return ""
    if re.match(r"^[-*_]{3,}$", out):
        return ""
    if re.match(r"^\(.*\)$", out):
        return ""
    out = re.sub(r"^#{1,6}\s+", "", out)
    out = re.sub(r"\*\*(.*?)\*\*", r"\1", out)
    out = re.sub(r"\*(.*?)\*", r"\1", out)
    out = re.sub(r"\[PAUSE_SHORT\]", " ... ", out, flags=re.I)
    out = re.sub(r"\[PAUSE_MEDIUM\]", " .... ", out, flags=re.I)
    out = re.sub(r"\[PAUSE_LONG\]", " ..... ", out, flags=re.I)
    out = re.sub(r"\[SCENE(?:N)?(?:\s*:[^\]]+)?\]", "", out, flags=re.I)

    def repl(m):
        raw = str(m.group(1) or "").strip()
        if not raw:
            return ""
        key = re.split(r"[\s:=,|]", raw)[0].lower()
        if key in ("intent", "emo", "emotion"):
            return m.group(0)
        return ""

    out = re.sub(r"\[([^\]]+)\]", repl, out)
    out = re.sub(r"\s+", " ", out).strip()
    return out


def parse_text(raw_text):
    raw = str(raw_text or "").replace("\ufeff", "")
    lines = raw.splitlines()
    meta = {}
    body = []
    body_started = False
    for line in lines:
        trimmed = line.strip()
        m = re.match(r"^([A-Z_]+)\s*:\s*(.+)$", trimmed)
        if (not body_started) and m and m.group(1) in META_KEYS:
            meta[m.group(1)] = m.group(2).strip()
            continue
        if (not body_started) and trimmed == "---":
            body_started = True
            continue
        if trimmed:
            body_started = True
        body.append(line)
    cleaned = "\n".join([x for x in (clean_line(x) for x in body) if x])
    return {"meta": meta, "text": cleaned}


def parse_input_file(file_path):
    with open(file_path, "r", encoding="utf-8") as f:
        return parse_text(f.read())


def load_text_lexicon(lexicon_path):
    payload = read_json_file(lexicon_path)
    if payload is None:
        return []
    if isinstance(payload, dict) and isinstance(payload.get("replacements"), list):
        rows = payload.get("replacements")
    elif isinstance(payload, dict):
        rows = [{"from": k, "to": v} for k, v in payload.items()]
    else:
        rows = []
    out = []
    for row in rows:
        from_v = str((row or {}).get("from") or "").strip()
        to_v = str((row or {}).get("to") or "").strip()
        if from_v and to_v and from_v != to_v:
            out.append({"from": from_v, "to": to_v})
    return out


def apply_lexicon_rewrite(text, lexicon_rows):
    out = str(text or "")
    for row in lexicon_rows:
        src = re.escape(str(row.get("from") or ""))
        dst = str(row.get("to") or "")
        if not src or not dst:
            continue
        pattern = re.compile(rf"(^|[^\w])({src})(?=$|[^\w])", re.I)
        out = pattern.sub(lambda m: f"{m.group(1)}{dst}", out)
    return out


def resolve_auto_punctuate_cfg(mode):
    key = str(mode or "balanced").strip().lower()
    if key == "conservative":
        return {
            "min_words_for_comma": 16,
            "question_starters": {"apa", "apakah", "siapa", "kapan", "dimana", "di mana", "kenapa", "mengapa", "bagaimana"},
            "exclaim_starters": {"astaga", "waduh"},
        }
    if key == "aggressive":
        return {
            "min_words_for_comma": 10,
            "question_starters": {
                "apa",
                "apakah",
                "siapa",
                "kapan",
                "dimana",
                "di mana",
                "kenapa",
                "mengapa",
                "bagaimana",
                "bisakah",
                "maukah",
                "haruskah",
            },
            "exclaim_starters": {"wow", "astaga", "waduh", "ya ampun", "gila", "hebat"},
        }
    return {
        "min_words_for_comma": 14,
        "question_starters": {"apa", "apakah", "siapa", "kapan", "dimana", "di mana", "kenapa", "mengapa", "bagaimana", "bisakah"},
        "exclaim_starters": {"wow", "astaga", "waduh", "ya ampun", "gila", "hebat"},
    }


def auto_punctuate_line(line, mode="balanced"):
    raw = str(line or "").strip()
    if not raw:
        return ""
    if re.search(r"[.!?:;\u2026]$", raw):
        return raw

    cfg = resolve_auto_punctuate_cfg(mode)
    text = re.sub(r"\s+", " ", raw).strip()
    lower = text.lower()
    words = [w for w in lower.split(" ") if w]
    if not words:
        return ""

    comma_connectors = {"tapi", "namun", "lalu", "kemudian", "dan", "sementara", "sedangkan"}
    candidate = text
    if "," not in candidate and len(words) >= cfg["min_words_for_comma"]:
        target = len(words) // 2
        best = -1
        best_dist = 10**9
        for i in range(2, len(words) - 2):
            token = re.sub(r"[^\w-]", "", words[i])
            if token not in comma_connectors:
                continue
            dist = abs(i - target)
            if dist < best_dist:
                best = i
                best_dist = dist
        if best > 1:
            raw_words = candidate.split(" ")
            raw_words[best] = ", " + raw_words[best]
            candidate = " ".join(raw_words).replace(" ,", ",")

    first = words[0]
    if first in cfg["question_starters"] or re.search(r"\bkah\b", lower):
        return candidate + "?"
    if first in cfg["exclaim_starters"] or re.match(r"^[A-Z0-9\s]{6,}$", text):
        return candidate + "!"
    return candidate + "."


def auto_punctuate_text(text, mode="balanced"):
    return "\n".join([x for x in (auto_punctuate_line(line, mode=mode) for line in str(text or "").splitlines()) if x])


def preprocess_text(text, auto_punctuate=True, auto_punctuate_mode="balanced", text_rewrite=True, text_lexicon_path=None):
    out = str(text or "").strip()
    if not out:
        return out
    if text_rewrite:
        lexicon = load_text_lexicon(text_lexicon_path or TEXT_LEXICON_PATH)
        out = apply_lexicon_rewrite(out, lexicon)
    if auto_punctuate:
        out = auto_punctuate_text(out, mode=auto_punctuate_mode)
    return out


def parse_intent_tag(text):
    raw = str(text or "")
    tag_re = re.compile(r"\[(?:intent|emo|emotion)\s*(?:=|:)\s*([a-z_]+)(?:\s*[,|:]\s*([0-9.]+))?\s*\]", re.I)
    tag = None
    for m in tag_re.finditer(raw):
        tag = {
            "intent": str(m.group(1) or "netral").strip().lower(),
            "intensity": clamp(float(m.group(2) or 1.0), 0.0, 1.0),
        }
    clean = tag_re.sub("", raw)
    clean = re.sub(r"\s+", " ", clean).strip()
    return {"clean": clean, "override": tag}


def to_word_tokens(text):
    return [w for w in str(text or "").strip().split() if w]


def split_segment_into_phrases(text, min_words=2, max_words=6, target_words=4):
    raw = str(text or "").strip()
    words = to_word_tokens(raw)
    if len(words) <= max_words + 2:
        return [raw] if raw else []

    # Flexible split: prioritize natural pause points and vary chunk size by local context.
    clauses = []
    pos = 0
    for m in re.finditer(r"([^,;:!?]+)([,;:!?]?)", raw):
        body = str(m.group(1) or "").strip()
        punct = str(m.group(2) or "")
        if body:
            clauses.append((body, punct))
        pos = m.end()
    if not clauses and raw:
        clauses = [(raw, "")]
    if pos < len(raw):
        tail = raw[pos:].strip()
        if tail:
            clauses.append((tail, ""))

    expressive_single = {
        "dan",
        "tapi",
        "namun",
        "lalu",
        "jadi",
        "karena",
        "bahkan",
        "oh",
        "ah",
        "wah",
        "hmm",
    }
    split_connectors = expressive_single | {"sementara", "sedangkan", "ketika", "meski", "walau"}
    out = []
    for clause, punct in clauses:
        c_words = to_word_tokens(clause)
        if not c_words:
            continue
        i = 0
        while i < len(c_words):
            remain = len(c_words) - i
            cur = str(c_words[i]).lower().strip(".,;:!?")

            local_max = max(3, min(9, int(max_words) + 3))
            local_min = 1
            local_target = max(2, min(local_max, int(target_words) + max(0, len(c_words) // 7)))

            if cur in expressive_single:
                size = 1
            else:
                size = min(remain, local_target)
                if i + size < len(c_words):
                    # Cut early before connector to keep phrasing human-like.
                    for j in range(1, min(size + 1, remain)):
                        nxt = str(c_words[i + j]).lower().strip(".,;:!?")
                        if nxt in split_connectors:
                            size = j
                            break

            if remain <= local_max:
                size = remain
            elif remain - size < local_min:
                size = max(local_min, remain - local_min)

            size = max(local_min, min(local_max, size))
            chunk = " ".join(c_words[i : i + size]).strip()
            if chunk:
                out.append(chunk)
            i += size

        if punct and out:
            out[-1] = f"{out[-1]}{punct}"
    return [x for x in out if x]


def split_into_segments(text):
    segments = []
    for line in str(text or "").splitlines():
        trimmed = line.strip()
        if not trimmed:
            continue
        parts = [p.strip() for p in re.split(r"(?<=[.!?;:])\s+", trimmed) if p.strip() and not re.fullmatch(r"\.+", p.strip())]
        for part in parts:
            tagged = parse_intent_tag(part)
            if not tagged["clean"]:
                continue
            phrases = split_segment_into_phrases(tagged["clean"])
            if not phrases:
                continue
            for phrase in phrases:
                segments.append({"text": phrase, "override": tagged["override"]})
    return segments


def normalize_style(style_name):
    key = str(style_name or "").strip().lower()
    return GLOBAL_STYLE_ALIASES.get(key, key or "natural")


def normalize_speech_style(style_name):
    key = str(style_name or "auto").strip().lower()
    aliases = {
        "default": "auto",
        "naratif": "narrative",
        "santai": "relaxed",
        "tegas": "assertive",
        "dramatis": "dramatic",
        "emosional": "emotional",
    }
    norm = aliases.get(key, key)
    return norm if norm in SPEECH_STYLE_PRESETS else "auto"


def load_runtime_defaults():
    payload = read_json_file(DEFAULTS_PATH) or {}
    rt = payload.get("selectedRuntime") if isinstance(payload, dict) else {}
    if not isinstance(rt, dict):
        rt = {}
    voice_cfg = rt.get("voiceCharacter") if isinstance(rt.get("voiceCharacter"), dict) else {}
    base_cfg = rt.get("base") if isinstance(rt.get("base"), dict) else {}
    return {
        "style": str(rt.get("style") or "").strip() or None,
        "profileFile": str(rt.get("profileFile") or "").strip() or None,
        "humanizeIntensity": clamp(to_num(rt.get("humanizeIntensity"), 0.45), 0.0, 1.0)
        if str(rt.get("humanizeIntensity") or "").strip()
        else None,
        "forceHumanize": bool(rt.get("forceHumanize")) if isinstance(rt.get("forceHumanize"), bool) else None,
        "sampleLock": bool(rt.get("sampleLock")) if isinstance(rt.get("sampleLock"), bool) else None,
        "autoExpressive": rt.get("autoExpressive") if isinstance(rt.get("autoExpressive"), bool) else None,
        "hybridProsody": rt.get("hybridProsody") if isinstance(rt.get("hybridProsody"), bool) else None,
        "prosodyLimiterEnabled": (
            (rt.get("prosodyLimiter") or {}).get("enabled")
            if isinstance(rt.get("prosodyLimiter"), dict) and isinstance((rt.get("prosodyLimiter") or {}).get("enabled"), bool)
            else None
        ),
        "prosodyLimiterStrength": clamp(to_num((rt.get("prosodyLimiter") or {}).get("strength"), 0.64), 0.3, 1.0)
        if isinstance(rt.get("prosodyLimiter"), dict) and str((rt.get("prosodyLimiter") or {}).get("strength") or "").strip()
        else None,
        "speechStyle": str(voice_cfg.get("speechStyle") or "").strip() or None,
        "voiceTone": str(voice_cfg.get("voiceTone") or "").strip() or None,
        "baseRate": str(base_cfg.get("rate") or "").strip() or None,
        "basePitch": str(base_cfg.get("pitch") or "").strip() or None,
        "baseVolume": str(base_cfg.get("volume") or "").strip() or None,
    }


def default_profile():
    return {
        "defaultStyle": "natural",
        "styles": {
            "natural": {
                "base": {"rate": 0, "pitch": 0, "volume": 0},
                "amplitude": {"rate": 5, "pitch": 2, "volume": 2},
            }
        },
    }


def load_active_profile(profile_file_override=None):
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    if profile_file_override:
        fp = PROFILE_DIR / str(profile_file_override)
        payload = read_json_file(fp)
        if isinstance(payload, dict):
            return {"file": fp.name, "profile": payload}
    active_name = "v1.json"
    active_cfg = read_json_file(PROFILE_DIR / "active.json") or {}
    if isinstance(active_cfg, dict) and str(active_cfg.get("activeProfile") or "").strip():
        active_name = str(active_cfg.get("activeProfile")).strip()
    payload = read_json_file(PROFILE_DIR / active_name)
    if not isinstance(payload, dict):
        payload = default_profile()
        with open(PROFILE_DIR / active_name, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
        with open(PROFILE_DIR / "active.json", "w", encoding="utf-8") as f:
            json.dump({"activeProfile": active_name}, f, indent=2, ensure_ascii=False)
    return {"file": active_name, "profile": payload}


def detect_intent_state(segment, idx, total, style_name, auto_expressive=True):
    text = str((segment or {}).get("text") or "").strip()
    low = text.lower()
    if auto_expressive is False:
        return {"intent": "netral", "intensity": 0.0, "source": "disabled"}
    override = (segment or {}).get("override") or {}
    if isinstance(override, dict) and str(override.get("intent") or "").strip():
        key = str(override.get("intent") or "").strip().lower()
        return {"intent": key, "intensity": clamp(float(override.get("intensity") or 1.0), 0.0, 1.0), "source": "tag_override"}

    best_intent = STYLE_INTENT_PRIOR.get(style_name, "netral")
    best_score = 1.2
    for name, regex in INTENT_PATTERNS.items():
        m = regex.findall(low)
        if m:
            score = 2.2 + len(m) * 0.5
            if score > best_score:
                best_score = score
                best_intent = name

    if idx == 0 and re.match(r"^(hai|halo|hello|hi)\b", text, re.I) and len(text) <= 20 and best_intent == "netral":
        best_intent = "ceria"
        best_score += 0.8
    if text.count("!") >= 2:
        best_intent = "kaget"
        best_score += 1.0
    intensity = clamp(0.35 + best_score / 6.0, 0.3, 1.0)
    return {"intent": best_intent, "intensity": intensity, "source": "auto"}


def apply_human_like_prosody_limiter(units, humanize_intensity=0.45, style_name="natural", enabled=True, strength=0.64):
    if not units:
        return []
    if not enabled:
        return [dict(x) for x in units]
    intensity = clamp(float(humanize_intensity), 0.0, 1.0)
    strength = clamp(float(strength), 0.3, 1.0)
    expressive = any(k in str(style_name or "").lower() for k in ("dram", "thriller", "sinem", "tegang"))

    abs_rate = 30.0 if expressive else 27.0
    abs_pitch = 18.0 if expressive else 16.5
    abs_volume = 16.0 if expressive else 14.0
    softness = 0.75 + strength * 0.25
    def _deterministic_jitter(idx, axis):
        base = (idx + 1) * (17 if axis == "rate" else 23 if axis == "pitch" else 29)
        noise = math.sin(base * 0.173) * 0.5 + math.cos(base * 0.097) * 0.5
        return noise

    out = []
    prev = None
    total = len(units)
    for idx, row in enumerate(units):
        nxt = dict(row)
        raw_text = str(nxt.get("text") or "")
        reason = nxt.get("reason") if isinstance(nxt.get("reason"), dict) else {}
        intent = str(reason.get("intent") or "netral").lower()
        intent_intensity = clamp(to_num(reason.get("intentIntensity"), 0.5), 0.0, 1.0)
        is_final_seg = idx == total - 1
        is_first_seg = idx == 0
        ending_q = raw_text.endswith("?")
        ending_x = raw_text.endswith("!")
        ending_e = raw_text.endswith("...")
        ending_p = raw_text.endswith(".")
        word_count = len(to_word_tokens(raw_text))
        emphatic = bool(re.search(r"\b(oh|ah|wah|hmm|ya|tidak|bukan)\b", raw_text, re.I))

        # Dynamic limiter strength per segment to avoid one-shape robot cadence.
        dyn_strength = strength
        if intent in ("kaget", "marah", "tegang"):
            dyn_strength -= 0.08 * intent_intensity
        elif intent in ("tenang", "sedih"):
            dyn_strength += 0.05 * intent_intensity
        if ending_q or ending_x:
            dyn_strength -= 0.04
        if ending_e:
            dyn_strength += 0.05
        if word_count <= 2 or emphatic:
            dyn_strength -= 0.05
        if word_count >= 12:
            dyn_strength += 0.04
        dyn_strength = clamp(dyn_strength, 0.3, 1.0)
        dyn_softness = 0.75 + dyn_strength * 0.25
        dyn_step_rate = (2.8 + intensity * 1.3) * dyn_softness + 0.55
        dyn_step_pitch = (2.0 + intensity * 1.0) * dyn_softness + 0.45
        dyn_step_volume = (1.8 + intensity * 0.9) * dyn_softness + 0.45

        # Controlled micro-variation to reduce repeated robotic contour.
        jitter_scale = 0.12 + (1.0 - dyn_strength) * 0.22
        nxt["rate"] = float(nxt.get("rate", 0.0)) + _deterministic_jitter(idx, "rate") * jitter_scale
        nxt["pitch"] = float(nxt.get("pitch", 0.0)) + _deterministic_jitter(idx, "pitch") * jitter_scale * 0.7
        nxt["volume"] = float(nxt.get("volume", 0.0)) + _deterministic_jitter(idx, "volume") * jitter_scale * 0.45

        # Opening/transition shaping: gentler lead-in and more elastic short chunks.
        if is_first_seg:
            nxt["rate"] -= 0.5
            nxt["pitch"] -= 0.2
        if word_count <= 2:
            nxt["rate"] += 1.2
            nxt["pitch"] += 0.35
        elif word_count >= 12:
            nxt["rate"] -= 0.8
            nxt["volume"] += 0.25

        # Anti-stretch ending: avoid over-long robotic tail at sentence/final endings.
        if ending_p and not ending_e:
            nxt["rate"] += 0.8
            nxt["pitch"] -= 0.25
        if ending_q:
            nxt["pitch"] += 0.65
        if ending_x:
            nxt["pitch"] += 0.35
            nxt["volume"] += 0.35
        if is_final_seg:
            nxt["rate"] += 1.0
            nxt["pitch"] -= 0.45

        nxt["rate"] = clamp(float(nxt.get("rate", 0.0)), -abs_rate, abs_rate)
        nxt["pitch"] = clamp(float(nxt.get("pitch", 0.0)), -abs_pitch, abs_pitch)
        nxt["volume"] = clamp(float(nxt.get("volume", 0.0)), -abs_volume, abs_volume)
        if prev is not None:
            nxt["rate"] = prev["rate"] + clamp(nxt["rate"] - prev["rate"], -dyn_step_rate, dyn_step_rate)
            nxt["pitch"] = prev["pitch"] + clamp(nxt["pitch"] - prev["pitch"], -dyn_step_pitch, dyn_step_pitch)
            nxt["volume"] = prev["volume"] + clamp(nxt["volume"] - prev["volume"], -dyn_step_volume, dyn_step_volume)
        out.append(nxt)
        prev = nxt
    return out


def build_segment_candidate_prosody(final_vals, text="", reason=None, idx=0, total=1, candidate_count=1):
    base = {
        "rate": float((final_vals or {}).get("rate", 0.0)),
        "pitch": float((final_vals or {}).get("pitch", 0.0)),
        "volume": float((final_vals or {}).get("volume", 0.0)),
    }
    n = max(1, min(int(candidate_count or 1), 6))
    if n <= 1:
        return [base]

    raw = str(text or "")
    words = len(to_word_tokens(raw))
    ending_q = raw.endswith("?")
    ending_x = raw.endswith("!")
    ending_e = raw.endswith("...")
    is_first = idx == 0
    is_last = idx == max(0, total - 1)
    intent = str((reason or {}).get("intent") or "netral").lower()
    intent_intensity = clamp(to_num((reason or {}).get("intentIntensity"), 0.5), 0.0, 1.0)

    out = [base]
    # Candidate 2: more expressive contour.
    c = dict(base)
    c["rate"] += 0.9 + (0.5 * intent_intensity if intent in ("kaget", "marah", "tegang") else 0.0)
    c["pitch"] += 0.45 + (0.3 * intent_intensity if ending_q or ending_x else 0.0)
    c["volume"] += 0.35
    if ending_q:
        c["pitch"] += 0.55
    if ending_x:
        c["pitch"] += 0.25
        c["volume"] += 0.45
    if words <= 2:
        c["rate"] += 0.8
    out.append(c)

    if n >= 3:
        # Candidate 3: slower and calmer for long/reflective phrase.
        c = dict(base)
        c["rate"] -= 1.1 + (0.35 * intent_intensity if intent in ("sedih", "tenang") else 0.0)
        c["pitch"] -= 0.35
        if words >= 10:
            c["rate"] -= 0.7
        if ending_e:
            c["rate"] -= 0.4
            c["pitch"] -= 0.25
        out.append(c)

    if n >= 4:
        # Candidate 4: transition-safe with modest movement.
        c = dict(base)
        c["rate"] += 0.2
        c["pitch"] += 0.1
        c["volume"] -= 0.15
        out.append(c)

    if n >= 5:
        # Candidate 5: clear ending release.
        c = dict(base)
        c["rate"] += 0.6
        c["pitch"] -= 0.4
        if is_last:
            c["rate"] += 0.5
            c["pitch"] -= 0.35
        out.append(c)

    if n >= 6:
        # Candidate 6: opening emphasis.
        c = dict(base)
        if is_first:
            c["rate"] -= 0.35
            c["pitch"] -= 0.25
        c["volume"] += 0.2
        out.append(c)

    clamped = []
    for cand in out[:n]:
        clamped.append(
            {
                "rate": clamp(float(cand.get("rate", 0.0)), -30.0, 30.0),
                "pitch": clamp(float(cand.get("pitch", 0.0)), -18.0, 18.0),
                "volume": clamp(float(cand.get("volume", 0.0)), -16.0, 16.0),
            }
        )
    return clamped


def score_segment_candidate(candidate, prev_final=None, text="", reason=None, idx=0, total=1):
    cand = candidate or {}
    rate = float(cand.get("rate", 0.0))
    pitch = float(cand.get("pitch", 0.0))
    volume = float(cand.get("volume", 0.0))
    raw = str(text or "")
    words = len(to_word_tokens(raw))
    ending_q = raw.endswith("?")
    ending_x = raw.endswith("!")
    ending_e = raw.endswith("...")
    ending_p = raw.endswith(".")
    intent = str((reason or {}).get("intent") or "netral").lower()
    intensity = clamp(to_num((reason or {}).get("intentIntensity"), 0.5), 0.0, 1.0)

    score = 0.0
    if prev_final is not None:
        pr = float(prev_final.get("rate", 0.0))
        pp = float(prev_final.get("pitch", 0.0))
        pv = float(prev_final.get("volume", 0.0))
        dr = abs(rate - pr)
        dp = abs(pitch - pp)
        dv = abs(volume - pv)
        # Penalize abrupt jumps but also penalize near-identical repetition.
        score += dr * 0.34 + dp * 0.44 + dv * 0.18
        if dr < 0.18 and dp < 0.15 and dv < 0.12:
            score += 0.9

    # Local pacing target by phrase length.
    target_rate = 0.0
    if words <= 2:
        target_rate = 1.1
    elif words >= 12:
        target_rate = -0.8
    score += abs(rate - target_rate) * 0.12

    # Ending-shape priors.
    if ending_q:
        if pitch < 0.0:
            score += 0.65
    if ending_x:
        if volume < 0.2:
            score += 0.55
    if ending_e:
        if rate > 0.4:
            score += 0.45
    if ending_p and (idx == total - 1) and pitch > 1.0:
        score += 0.4

    # Intent alignment.
    if intent in ("kaget", "marah", "tegang"):
        if volume < -0.1:
            score += 0.45 * (0.6 + intensity)
    if intent in ("sedih", "tenang"):
        if rate > 1.2:
            score += 0.35 * (0.6 + intensity)
    return float(score)


def count_letters(text):
    return sum(1 for c in str(text or "") if ("a" <= c <= "z") or ("A" <= c <= "Z"))


def count_upper(text):
    return sum(1 for c in str(text or "") if "A" <= c <= "Z")


def style_hash(style):
    h = 0
    s = str(style or "natural")
    for ch in s:
        h = (h * 31 + ord(ch)) % 997
    return h / 997.0


def feature_vector(segment, idx, total, style):
    text = str((segment or {}).get("text") or "")
    letters = count_letters(text)
    upper_ratio = (count_upper(text) / letters) if letters > 0 else 0.0
    words = len(text.strip().split()) if text.strip() else 0
    pos = (idx / (total - 1)) if total > 1 else 0.0
    return [
        float(len(text)),
        float(words),
        1.0 if text.endswith(".") else 0.0,
        1.0 if text.endswith("?") else 0.0,
        1.0 if text.endswith("!") else 0.0,
        1.0 if text.endswith("...") else 0.0,
        upper_ratio,
        1.0 if any(ch.isdigit() for ch in text) else 0.0,
        pos,
        math.sin(pos * math.pi),
        math.cos(pos * math.pi),
        float(segment.get("rate", 0.0)),
        float(segment.get("pitch", 0.0)),
        float(segment.get("volume", 0.0)),
        style_hash(style),
    ]


def load_policy_model():
    payload = read_json_file(POLICY_MODEL_PATH)
    if not isinstance(payload, dict):
        return None
    if payload.get("modelType") == "linear_py_v1":
        return payload
    return None


def predict_adjustment(policy, segment, idx, total, style):
    if not isinstance(policy, dict):
        return {"dr": 0.0, "dp": 0.0, "dv": 0.0}
    weights = policy.get("weights")
    intercept = policy.get("intercept")
    if not isinstance(weights, list) or not isinstance(intercept, list):
        model = policy.get("model") if isinstance(policy.get("model"), dict) else {}
        weights = model.get("weights")
        intercept = model.get("intercept")
    if not isinstance(weights, list) or not isinstance(intercept, list):
        return {"dr": 0.0, "dp": 0.0, "dv": 0.0}
    feat = feature_vector(segment, idx, total, style)
    out = [float(intercept[0] if len(intercept) > 0 else 0.0), float(intercept[1] if len(intercept) > 1 else 0.0), float(intercept[2] if len(intercept) > 2 else 0.0)]
    dim = min(len(feat), len(weights))
    for i in range(dim):
        row = weights[i] if isinstance(weights[i], list) else [0.0, 0.0, 0.0]
        x = float(feat[i])
        out[0] += x * float(row[0] if len(row) > 0 else 0.0)
        out[1] += x * float(row[1] if len(row) > 1 else 0.0)
        out[2] += x * float(row[2] if len(row) > 2 else 0.0)
    return {"dr": out[0], "dp": out[1], "dv": out[2]}


def build_prosody_map(
    segments,
    rate="-8%",
    pitch="-2Hz",
    volume="0%",
    humanize_intensity=0.45,
    style=None,
    profile_file=None,
    auto_expressive=True,
    speech_style="auto",
):
    profile_pack = load_active_profile(profile_file_override=profile_file)
    profile = profile_pack["profile"]
    styles = profile.get("styles") if isinstance(profile, dict) else {}
    styles = styles if isinstance(styles, dict) else {}
    default_style = str((profile or {}).get("defaultStyle") or "natural")
    requested = normalize_style(style)
    selected_style = requested if requested in styles else default_style
    style_cfg = styles.get(selected_style) if isinstance(styles.get(selected_style), dict) else {}
    base_cfg = style_cfg.get("base") if isinstance(style_cfg.get("base"), dict) else {}
    amp_cfg = style_cfg.get("amplitude") if isinstance(style_cfg.get("amplitude"), dict) else {}

    speech_key = normalize_speech_style(speech_style)
    speech = SPEECH_STYLE_PRESETS.get(speech_key, SPEECH_STYLE_PRESETS["auto"])
    base_rate = parse_percent_number(rate, 0.0) + float(base_cfg.get("rate", 0.0)) + float((speech.get("base") or {}).get("rate", 0.0))
    base_pitch = parse_hz_number(pitch, 0.0) + float(base_cfg.get("pitch", 0.0)) + float((speech.get("base") or {}).get("pitch", 0.0))
    base_volume = parse_percent_number(volume, 0.0) + float(base_cfg.get("volume", 0.0)) + float((speech.get("base") or {}).get("volume", 0.0))
    intensity = clamp(float(humanize_intensity), 0.0, 1.0)
    rate_amp = float(amp_cfg.get("rate", 5.0)) * intensity * 0.9 * float((speech.get("amp") or {}).get("rate", 1.0))
    pitch_amp = float(amp_cfg.get("pitch", 2.0)) * intensity * 0.95 * float((speech.get("amp") or {}).get("pitch", 1.0))
    volume_amp = float(amp_cfg.get("volume", 2.0)) * intensity * 0.7 * float((speech.get("amp") or {}).get("volume", 1.0))

    wave_freq = 1.1
    wave_phase = 0.0
    out = []
    speech_final_delta = {
        "auto": {"rate": 0.0, "pitch": 0.0, "volume": 0.0},
        "narrative": {"rate": 0.0, "pitch": 0.0, "volume": 0.0},
        "relaxed": {"rate": -2.4, "pitch": -0.3, "volume": -0.25},
        "assertive": {"rate": 4.0, "pitch": -0.5, "volume": 0.9},
        "dramatic": {"rate": 1.0, "pitch": 0.8, "volume": 0.6},
        "emotional": {"rate": 0.5, "pitch": 1.0, "volume": 0.5},
    }.get(speech_key, {"rate": 0.0, "pitch": 0.0, "volume": 0.0})
    for i, segment in enumerate(segments):
        text = str(segment.get("text") or "")
        wave = math.sin(i * wave_freq + wave_phase)
        r = base_rate + wave * rate_amp
        p = base_pitch + wave * pitch_amp
        v = base_volume + wave * volume_amp

        intent_state = detect_intent_state(segment, i, len(segments), selected_style, auto_expressive=auto_expressive)
        ib = INTENT_PROSODY.get(intent_state.get("intent"), INTENT_PROSODY["netral"])
        r += ib["rate"] * intensity * float(intent_state.get("intensity", 0.0))
        p += ib["pitch"] * intensity * float(intent_state.get("intensity", 0.0))
        v += ib["volume"] * intensity * float(intent_state.get("intensity", 0.0))
        if text.endswith("?"):
            p += 0.8 * intensity
        if text.endswith("!"):
            r += 0.6 * intensity
            v += 0.6 * intensity
        if text.endswith("..."):
            r -= 0.8 * intensity

        # Calibration to keep Python prosody averages near JS runtime behavior.
        r += 13.4 + float(speech_final_delta.get("rate", 0.0))
        p += 4.7 + float(speech_final_delta.get("pitch", 0.0))
        v += 2.8 + float(speech_final_delta.get("volume", 0.0))

        out.append(
            {
                "index": i + 1,
                "text": text,
                "rate": clamp(r, -35.0, 35.0),
                "pitch": clamp(p, -20.0, 20.0),
                "volume": clamp(v, -20.0, 20.0),
                "reason": {
                    "style": selected_style,
                    "profileFile": profile_pack["file"],
                    "speechStyle": speech_key,
                    "intent": intent_state.get("intent") or "netral",
                    "intentIntensity": float(intent_state.get("intensity", 0.0)),
                    "intentSource": intent_state.get("source") or "auto",
                },
            }
        )
    return {"segments": out, "styleName": selected_style, "profileFile": profile_pack["file"], "speechStyle": speech_key}


def preview_auto_expression_from_text(
    text,
    rate="-8%",
    pitch="-2Hz",
    volume="0%",
    humanize_intensity=0.45,
    style=None,
    profile_file=None,
    prosody_limiter=True,
    prosody_limiter_strength=0.64,
    auto_expressive=True,
    allow_intent_override=True,
    auto_punctuate=True,
    auto_punctuate_mode="balanced",
    text_rewrite=True,
    text_lexicon_path=None,
):
    prepared = preprocess_text(
        text=text,
        auto_punctuate=auto_punctuate,
        auto_punctuate_mode=auto_punctuate_mode,
        text_rewrite=text_rewrite,
        text_lexicon_path=text_lexicon_path,
    )
    segments = split_into_segments(prepared)
    if not segments:
        raise RuntimeError("no_text_segments_for_preview")
    if not allow_intent_override:
        for seg in segments:
            seg["override"] = None
    built = build_prosody_map(
        segments=segments,
        rate=rate,
        pitch=pitch,
        volume=volume,
        humanize_intensity=humanize_intensity,
        style=style,
        profile_file=profile_file,
        auto_expressive=auto_expressive,
    )
    built["segments"] = apply_human_like_prosody_limiter(
        built.get("segments") or [],
        humanize_intensity=humanize_intensity,
        style_name=built.get("styleName") or "natural",
        enabled=bool(prosody_limiter),
        strength=float(prosody_limiter_strength),
    )
    return built


def format_percent_signed(v):
    iv = int(round(float(v)))
    return f"{iv:+d}%"


def format_hz_signed(v):
    iv = int(round(float(v)))
    return f"{iv:+d}Hz"


def resolve_ffmpeg_path():
    local = Path("node_modules/ffmpeg-static/ffmpeg.exe")
    if local.exists():
        return str(local.resolve())
    found = shutil.which("ffmpeg")
    if found:
        return found
    return None


async def synth_edge_segment(text, output_mp3, voice, rate, pitch, volume):
    if edge_tts is None:
        raise RuntimeError("python_edge_tts_not_installed. Install with: pip install edge-tts")
    communicate = edge_tts.Communicate(text=str(text or ""), voice=str(voice), rate=str(rate), pitch=str(pitch), volume=str(volume))
    await communicate.save(str(output_mp3))
    return str(output_mp3)


def concat_mp3_files(segment_paths, output_path):
    ffmpeg = resolve_ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError("ffmpeg_not_found. Install ffmpeg or keep node_modules/ffmpeg-static available.")
    with tempfile.NamedTemporaryFile(prefix="concat_", suffix=".txt", delete=False, mode="w", encoding="utf-8") as f:
        list_path = f.name
        for item in segment_paths:
            norm = str(Path(item).resolve()).replace("\\", "/")
            f.write(f"file '{norm}'\n")
    try:
        cmd = [
            ffmpeg,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list_path,
            "-vn",
            "-ar",
            "24000",
            "-ac",
            "1",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "128k",
            str(output_path),
        ]
        res = subprocess.run(cmd, cwd=os.getcwd(), capture_output=True, text=True, encoding="utf-8", shell=False)
        if int(res.returncode or 0) != 0:
            raise RuntimeError((res.stderr or res.stdout or "").strip() or "ffmpeg_concat_failed")
    finally:
        try:
            os.remove(list_path)
        except Exception:
            pass


def apply_voice_character_postprocess(input_path, output_path, voice_tone="auto", voice_character=True):
    if not bool(voice_character):
        return False
    tone = str(voice_tone or "auto").strip().lower()
    if tone in ("off", "none", "raw"):
        return False
    ffmpeg = resolve_ffmpeg_path()
    if not ffmpeg:
        return False

    low_db = 0.0
    high_db = 0.0
    comp_ratio = 1.8
    if tone in ("deep", "berat"):
        low_db += 1.2
        high_db -= 1.0
        comp_ratio += 0.3
    elif tone in ("bright", "cerah"):
        low_db -= 0.7
        high_db += 1.1
    elif tone in ("clear", "jernih"):
        low_db -= 0.4
        high_db += 0.8
        comp_ratio -= 0.2
    elif tone in ("soft", "halus"):
        high_db -= 0.5
        comp_ratio += 0.2

    filt = ",".join(
        [
            f"equalizer=f=120:width_type=h:width=160:g={clamp(low_db,-6,8):.2f}",
            f"equalizer=f=3200:width_type=h:width=1800:g={clamp(high_db,-6,6):.2f}",
            f"acompressor=threshold=-18dB:ratio={clamp(comp_ratio,1.2,8):.2f}:attack=20:release=220",
        ]
    )
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(input_path),
        "-vn",
        "-af",
        filt,
        "-ar",
        "24000",
        "-ac",
        "1",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        str(output_path),
    ]
    res = subprocess.run(cmd, cwd=os.getcwd(), capture_output=True, text=True, encoding="utf-8", shell=False)
    return int(res.returncode or 0) == 0 and Path(output_path).exists()


async def synthesize_to_mp3(text, output, voice, rate="-8%", pitch="-2Hz", volume="0%", auto_punctuate=True, auto_punctuate_mode="balanced", text_rewrite=True, text_lexicon_path=None):
    prepared = preprocess_text(
        text=text,
        auto_punctuate=auto_punctuate,
        auto_punctuate_mode=auto_punctuate_mode,
        text_rewrite=text_rewrite,
        text_lexicon_path=text_lexicon_path,
    )
    if not prepared.strip():
        raise RuntimeError("input_text_empty_after_cleanup")
    target = Path(str(output)).with_suffix(".mp3").resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    await synth_edge_segment(prepared, target, voice, rate, pitch, volume)
    return str(target)


async def synthesize_humanized_to_mp3(
    text,
    output,
    voice,
    rate="-8%",
    pitch="-2Hz",
    volume="0%",
    humanize_intensity=0.45,
    style=None,
    speech_style="auto",
    use_ml_policy=True,
    profile_file=None,
    auto_expressive=True,
    voice_character=True,
    voice_tone="auto",
    segment_concurrency=1,
    prosody_limiter=True,
    prosody_limiter_strength=0.64,
    save_prosody=True,
    auto_punctuate=True,
    auto_punctuate_mode="balanced",
    text_rewrite=True,
    text_lexicon_path=None,
    multi_prosody_candidates=1,
):
    prepared = preprocess_text(
        text=text,
        auto_punctuate=auto_punctuate,
        auto_punctuate_mode=auto_punctuate_mode,
        text_rewrite=text_rewrite,
        text_lexicon_path=text_lexicon_path,
    )
    segments = split_into_segments(prepared)
    if not segments:
        raise RuntimeError("no_text_segments_for_humanize")

    built = build_prosody_map(
        segments=segments,
        rate=rate,
        pitch=pitch,
        volume=volume,
        humanize_intensity=humanize_intensity,
        style=style,
        profile_file=profile_file,
        auto_expressive=auto_expressive,
        speech_style=speech_style,
    )
    prosody = built["segments"]
    policy = load_policy_model() if use_ml_policy else None
    proposed = []
    for i, seg in enumerate(prosody):
        ml = predict_adjustment(policy, seg, i, len(prosody), built["styleName"]) if policy else {"dr": 0.0, "dp": 0.0, "dv": 0.0}
        proposed.append(
            {
                "seg": seg,
                "ml": ml,
                "rate": clamp(float(seg["rate"]) + float(ml["dr"]), -35.0, 35.0),
                "pitch": clamp(float(seg["pitch"]) + float(ml["dp"]), -20.0, 20.0),
                "volume": clamp(float(seg["volume"]) + float(ml["dv"]), -20.0, 20.0),
            }
        )

    limited = apply_human_like_prosody_limiter(
        [
            {
                "rate": x["rate"],
                "pitch": x["pitch"],
                "volume": x["volume"],
                "text": str((x.get("seg") or {}).get("text") or ""),
                "reason": (x.get("seg") or {}).get("reason") or {},
            }
            for x in proposed
        ],
        humanize_intensity=humanize_intensity,
        style_name=built["styleName"],
        enabled=bool(prosody_limiter),
        strength=float(prosody_limiter_strength),
    )
    for i, row in enumerate(proposed):
        row["final"] = limited[i]
        row["candidates"] = build_segment_candidate_prosody(
            row["final"],
            text=str((row.get("seg") or {}).get("text") or ""),
            reason=(row.get("seg") or {}).get("reason") or {},
            idx=i,
            total=len(proposed),
            candidate_count=multi_prosody_candidates,
        )

    out_base = Path(str(output)).with_suffix("").resolve()
    out_base.parent.mkdir(parents=True, exist_ok=True)
    target_mp3 = str(out_base.with_suffix(".mp3"))
    cache_dir = Path(".tts-cache") / f"humanize_py_{os.getpid()}_{int(asyncio.get_event_loop().time() * 1000)}"
    cache_dir.mkdir(parents=True, exist_ok=True)

    sem = asyncio.Semaphore(max(1, min(int(segment_concurrency or 1), 8)))
    seg_paths = [None] * len(proposed)

    prev_selected = None
    for idx, unit in enumerate(proposed):
        seg = unit["seg"]
        cands = unit.get("candidates") if isinstance(unit.get("candidates"), list) else []
        if not cands:
            cands = [unit.get("final") or {"rate": 0.0, "pitch": 0.0, "volume": 0.0}]

        synth_paths = [None] * len(cands)

        async def _run_candidate(cidx, cand):
            seg_out = cache_dir / f"seg_{idx+1:04d}_c{cidx+1:02d}.mp3"
            async with sem:
                await synth_edge_segment(
                    text=seg["text"],
                    output_mp3=seg_out,
                    voice=voice,
                    rate=format_percent_signed(cand["rate"]),
                    pitch=format_hz_signed(cand["pitch"]),
                    volume=format_percent_signed(cand["volume"]),
                )
            synth_paths[cidx] = str(seg_out)

        await asyncio.gather(*[_run_candidate(ci, cand) for ci, cand in enumerate(cands)])

        best_idx = 0
        best_score = None
        for ci, cand in enumerate(cands):
            sc = score_segment_candidate(
                cand,
                prev_final=prev_selected,
                text=seg.get("text") or "",
                reason=seg.get("reason") or {},
                idx=idx,
                total=len(proposed),
            )
            if best_score is None or sc < best_score:
                best_score = sc
                best_idx = ci

        selected = cands[best_idx]
        seg["ml"] = unit["ml"]
        seg["final"] = {"rate": selected["rate"], "pitch": selected["pitch"], "volume": selected["volume"]}
        seg["selectedCandidate"] = int(best_idx + 1)
        seg["candidateCount"] = int(len(cands))
        seg_paths[idx] = str(synth_paths[best_idx])
        prev_selected = selected

        for ci, pth in enumerate(synth_paths):
            if ci == best_idx or not pth:
                continue
            try:
                os.remove(pth)
            except Exception:
                pass

    concat_mp3_files(seg_paths, target_mp3)
    post_applied = False
    post_path = str(out_base.with_name(out_base.name + ".post.mp3"))
    if apply_voice_character_postprocess(target_mp3, post_path, voice_tone=voice_tone, voice_character=voice_character):
        try:
            os.replace(post_path, target_mp3)
        except Exception:
            pass
        post_applied = True
    elif Path(post_path).exists():
        try:
            os.remove(post_path)
        except Exception:
            pass

    prosody_path = None
    if save_prosody:
        prosody_path = str(out_base.with_suffix(".prosody.json"))
        with open(prosody_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                    "voice": voice,
                    "base": {"rate": rate, "pitch": pitch, "volume": volume},
                    "style": built["styleName"],
                    "profileFile": built["profileFile"],
                    "humanizeIntensity": float(humanize_intensity),
                    "hybridProsody": True,
                    "prosodyLimiter": {"enabled": bool(prosody_limiter), "strength": float(prosody_limiter_strength)},
                    "mlPolicy": {"enabled": bool(policy), "modelMeta": (policy or {}).get("meta") if isinstance(policy, dict) else None},
                    "segments": prosody,
                    "voiceCharacter": {
                        "speechStyle": built.get("speechStyle") or "auto",
                        "voiceTone": str(voice_tone or "auto"),
                        "postApplied": bool(post_applied),
                    },
                },
                f,
                indent=2,
                ensure_ascii=False,
            )

    shutil.rmtree(cache_dir, ignore_errors=True)
    return {
        "audioPath": target_mp3,
        "prosodyPath": prosody_path,
        "segments": len(prosody),
        "style": built["styleName"],
        "profileFile": built["profileFile"],
    }


def choose_style(args_style, env_style):
    rt = load_runtime_defaults()
    if str(args_style or "").strip():
        return str(args_style).strip()
    if str(env_style or "").strip():
        return str(env_style).strip()
    return str(rt.get("style") or "natural")


def choose_runtime_bools(args_val, env_key, rt_default, fallback):
    env_val = os.environ.get(env_key)
    if args_val is not None:
        return to_bool(args_val, fallback)
    if env_val is not None:
        return to_bool(env_val, fallback)
    if rt_default is not None:
        return bool(rt_default)
    return fallback
