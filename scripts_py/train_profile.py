import argparse
import copy
import json
import math
import os
import re
from datetime import datetime, timezone


def read_ndjson(file_path):
    if not os.path.exists(file_path):
        return []
    rows = []
    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows


def read_json(file_path):
    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)


def as_num(value, fallback=0.0):
    try:
        n = float(value)
        if math.isfinite(n):
            return n
    except Exception:
        pass
    return fallback


def read_row_text(row, snake_key, camel_key=""):
    raw = row.get(snake_key)
    if raw is None and camel_key:
        raw = row.get(camel_key)
    if raw is None:
        return ""
    return str(raw).strip()


def read_row_number(row, snake_key, camel_key="", fallback=0.0):
    raw = row.get(snake_key)
    if raw is None and camel_key:
        raw = row.get(camel_key)
    return as_num(raw, fallback)


def ensure_style(profile, style_name):
    styles = profile.setdefault("styles", {})
    if style_name not in styles:
        default_style = profile.get("defaultStyle", "natural")
        styles[style_name] = copy.deepcopy(styles.get(default_style, {}))
    return styles[style_name]


def adjust_by_score(style, avg_score):
    delta = 3.6 - avg_score
    if delta <= 0:
        return
    amp = style.setdefault("amplitude", {})
    amp["rate"] = min(12.0, as_num(amp.get("rate"), 0.0) + delta * 0.8)
    amp["pitch"] = min(6.0, as_num(amp.get("pitch"), 0.0) + delta * 0.4)
    amp["volume"] = min(5.0, as_num(amp.get("volume"), 0.0) + delta * 0.5)


def apply_keyword_heuristic(style, notes):
    text = str(notes or "").lower()
    if not text:
        return
    base = style.setdefault("base", {})
    amp = style.setdefault("amplitude", {})
    if "terlalu cepat" in text:
        base["rate"] = as_num(base.get("rate"), 0.0) - 2
    if "terlalu lambat" in text:
        base["rate"] = as_num(base.get("rate"), 0.0) + 2
    if "terlalu tinggi" in text or "cempreng" in text:
        base["pitch"] = as_num(base.get("pitch"), 0.0) - 1
    if "terlalu rendah" in text:
        base["pitch"] = as_num(base.get("pitch"), 0.0) + 1
    if "kurang emosi" in text or "datar" in text or "robot" in text:
        amp["rate"] = as_num(amp.get("rate"), 0.0) + 1.2
        amp["pitch"] = as_num(amp.get("pitch"), 0.0) + 0.8
        amp["volume"] = as_num(amp.get("volume"), 0.0) + 0.8
    if "terlalu keras" in text:
        base["volume"] = as_num(base.get("volume"), 0.0) - 1
    if "terlalu pelan" in text:
        base["volume"] = as_num(base.get("volume"), 0.0) + 1


def apply_structured_feedback(style, row):
    intent = read_row_text(row, "intent_target", "intentTarget").lower()
    intensity = max(0.0, min(1.0, read_row_number(row, "intensity_target", "intensityTarget", 0.5)))
    transition = read_row_text(row, "transition_note", "transitionNote").lower()
    voice_fit = max(1.0, min(5.0, read_row_number(row, "voice_fit", "voiceFit", 4.0)))

    base = style.setdefault("base", {})
    amp = style.setdefault("amplitude", {})
    intensity_scale = 0.6 + intensity * 0.8

    if intent in ("tegang", "kaget"):
        base["rate"] = as_num(base.get("rate"), 0.0) - 0.5 * intensity_scale
        base["pitch"] = as_num(base.get("pitch"), 0.0) - 0.4 * intensity_scale
        amp["rate"] = as_num(amp.get("rate"), 0.0) + 0.7 * intensity_scale
        amp["volume"] = as_num(amp.get("volume"), 0.0) + 0.5 * intensity_scale
    elif intent in ("tenang", "sedih"):
        base["rate"] = as_num(base.get("rate"), 0.0) - 0.5 * intensity_scale
        amp["rate"] = as_num(amp.get("rate"), 0.0) + 0.25 * intensity_scale
        amp["pitch"] = as_num(amp.get("pitch"), 0.0) + 0.2 * intensity_scale
    elif intent == "tegas":
        base["volume"] = as_num(base.get("volume"), 0.0) + 0.35 * intensity_scale
        base["pitch"] = as_num(base.get("pitch"), 0.0) - 0.25 * intensity_scale
    elif intent == "ceria":
        base["rate"] = as_num(base.get("rate"), 0.0) + 0.35 * intensity_scale
        base["pitch"] = as_num(base.get("pitch"), 0.0) + 0.35 * intensity_scale
        amp["pitch"] = as_num(amp.get("pitch"), 0.0) + 0.45 * intensity_scale

    if "abrupt" in transition or "patah" in transition:
        amp["rate"] = as_num(amp.get("rate"), 0.0) - 0.25
        amp["pitch"] = as_num(amp.get("pitch"), 0.0) - 0.2
    elif "flat" in transition or "datar" in transition:
        amp["rate"] = as_num(amp.get("rate"), 0.0) + 0.2
        amp["pitch"] = as_num(amp.get("pitch"), 0.0) + 0.2

    if voice_fit <= 2:
        base["pitch"] = as_num(base.get("pitch"), 0.0) - 0.2
        base["volume"] = as_num(base.get("volume"), 0.0) + 0.15
    elif voice_fit >= 5:
        amp["volume"] = as_num(amp.get("volume"), 0.0) + 0.1


def clamp_style(style):
    base = style.setdefault("base", {})
    amp = style.setdefault("amplitude", {})
    base["rate"] = max(-25.0, min(10.0, as_num(base.get("rate"), 0.0)))
    base["pitch"] = max(-12.0, min(10.0, as_num(base.get("pitch"), 0.0)))
    base["volume"] = max(-10.0, min(10.0, as_num(base.get("volume"), 0.0)))
    amp["rate"] = max(1.0, min(15.0, as_num(amp.get("rate"), 0.0)))
    amp["pitch"] = max(0.5, min(8.0, as_num(amp.get("pitch"), 0.0)))
    amp["volume"] = max(0.5, min(6.0, as_num(amp.get("volume"), 0.0)))


def train_profile(profile, feedback_rows):
    out = copy.deepcopy(profile)
    grouped = {}
    default_style = out.get("defaultStyle", "natural")
    for row in feedback_rows:
        style = row.get("style") or default_style
        grouped.setdefault(style, []).append(row)

    for style_name, rows in grouped.items():
        style = ensure_style(out, style_name)
        weighted = []
        for r in rows:
            score = read_row_number(r, "score", "", 3.0)
            voice_fit = max(1.0, min(5.0, read_row_number(r, "voice_fit", "voiceFit", 4.0)))
            weighted.append(score * (0.75 + voice_fit / 10.0))
        avg_score = sum(weighted) / max(1, len(weighted))
        adjust_by_score(style, avg_score)
        for row in rows:
            apply_keyword_heuristic(style, row.get("notes"))
            apply_structured_feedback(style, row)
        clamp_style(style)
    return out


def to_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    v = str(value).strip().lower()
    if v in ("1", "true", "yes", "y", "on"):
        return True
    if v in ("0", "false", "no", "n", "off"):
        return False
    return default


def get_active_profile_file(cwd):
    active_file = os.path.join(cwd, "config", "profiles", "active.json")
    if not os.path.exists(active_file):
        return "v1.json"
    try:
        data = read_json(active_file)
        return str(data.get("activeProfile") or "v1.json")
    except Exception:
        return "v1.json"


def set_active_profile_file(cwd, file_name):
    active_file = os.path.join(cwd, "config", "profiles", "active.json")
    parent = os.path.dirname(active_file)
    if parent and not os.path.exists(parent):
        os.makedirs(parent, exist_ok=True)
    with open(active_file, "w", encoding="utf-8") as f:
        json.dump({"activeProfile": file_name}, f, indent=2)


def list_profile_files(cwd):
    pdir = os.path.join(cwd, "config", "profiles")
    if not os.path.exists(pdir):
        return []
    out = []
    for name in os.listdir(pdir):
        if name.endswith(".json") and name != "active.json":
            out.append(name)
    out.sort()
    return out


def get_next_profile_file(cwd):
    nums = []
    for name in list_profile_files(cwd):
        m = re.match(r"^v(\d+)\.json$", name, flags=re.IGNORECASE)
        if m:
            try:
                nums.append(int(m.group(1)))
            except Exception:
                pass
    nxt = (max(nums) + 1) if nums else 1
    return f"v{nxt}.json"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--feedback-file", default="data/training/feedback.ndjson")
    parser.add_argument("--base-profile", default="")
    parser.add_argument("--output-file", default="")
    parser.add_argument("--apply", default="false")
    parser.add_argument("--min-feedback", type=int, default=1)
    args = parser.parse_args()

    cwd = os.getcwd()
    feedback_file = os.path.abspath(args.feedback_file)
    base_profile_file = str(args.base_profile).strip() or get_active_profile_file(cwd)
    base_profile_path = os.path.abspath(os.path.join(cwd, "config", "profiles", base_profile_file))
    output_file_arg = str(args.output_file).strip()
    output_file_name = output_file_arg if output_file_arg else get_next_profile_file(cwd)
    output_file = os.path.abspath(os.path.join(cwd, "config", "profiles", output_file_name))
    apply = to_bool(args.apply, default=False)

    feedback_rows = read_ndjson(feedback_file)
    if len(feedback_rows) < max(1, int(args.min_feedback)):
        print(f"Training skipped: not_enough_feedback ({len(feedback_rows)})")
        return

    base_profile = read_json(base_profile_path)
    trained = train_profile(base_profile, feedback_rows)
    before = json.dumps(base_profile, ensure_ascii=False, sort_keys=True)
    after = json.dumps(trained, ensure_ascii=False, sort_keys=True)
    if before == after:
        print("Training skipped: no_profile_change")
        return

    trained.setdefault("meta", {})
    trained["meta"]["id"] = os.path.basename(output_file).replace(".json", "")
    trained["meta"]["trainedFrom"] = os.path.basename(base_profile_path)
    trained["meta"]["trainedAt"] = datetime.now(timezone.utc).isoformat()
    trained["meta"]["feedbackCount"] = len(feedback_rows)
    trained["meta"]["feedbackFile"] = os.path.relpath(feedback_file, cwd).replace("\\", "/")
    trained["meta"]["trainer"] = "python"

    parent = os.path.dirname(output_file)
    if parent and not os.path.exists(parent):
        os.makedirs(parent, exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(trained, f, indent=2, ensure_ascii=False)
    if apply:
        set_active_profile_file(cwd, os.path.basename(output_file))
    print(f"Training complete: {output_file}")
    print(f"From profile: {os.path.basename(base_profile_path)}")
    print(f"Feedback rows: {len(feedback_rows)}")
    print(f"Applied: {str(apply).lower()}")
    print(f"Feedback file: {os.path.relpath(feedback_file, cwd).replace('\\', '/')}")


if __name__ == "__main__":
    main()
