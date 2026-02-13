import json
import math
import os
from pathlib import Path

try:
    import numpy as np
except Exception:
    np = None


def as_num(value, fallback=0.0):
    try:
        n = float(value)
        if math.isfinite(n):
            return n
    except Exception:
        pass
    return fallback


def clamp(n, lo, hi):
    return max(lo, min(hi, n))


def read_ndjson(file_path):
    if not os.path.exists(file_path):
        return []
    out = []
    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                continue
    return out


def style_hash(style):
    h = 0
    s = str(style or "natural")
    for ch in s:
        h = (h * 31 + ord(ch)) % 997
    return h / 997.0


def has_any(text, words):
    t = str(text or "").lower()
    return any(w in t for w in words)


def resolve_prosody_path(cwd, row):
    p = row.get("prosodyFile")
    if not p:
        return None
    target = Path(cwd) / "outputs" / str(p)
    return target if target.exists() else None


def transition_score(segments):
    if not isinstance(segments, list) or len(segments) <= 1:
        return 0.0
    acc = 0.0
    for i in range(1, len(segments)):
        a = segments[i - 1] or {}
        b = segments[i] or {}
        av = a.get("final") if isinstance(a.get("final"), dict) else a
        bv = b.get("final") if isinstance(b.get("final"), dict) else b
        acc += (
            abs(as_num(bv.get("rate"), 0.0) - as_num(av.get("rate"), 0.0))
            + abs(as_num(bv.get("pitch"), 0.0) - as_num(av.get("pitch"), 0.0))
            + abs(as_num(bv.get("volume"), 0.0) - as_num(av.get("volume"), 0.0))
        )
    return acc / (len(segments) - 1)


def prosody_energy(segments):
    if not isinstance(segments, list) or not segments:
        return 0.0
    acc = 0.0
    for s in segments:
        v = s.get("final") if isinstance(s.get("final"), dict) else s
        acc += abs(as_num(v.get("rate"), 0.0)) + abs(as_num(v.get("pitch"), 0.0)) + abs(as_num(v.get("volume"), 0.0))
    return acc / len(segments)


def read_prosody_stats(cwd, row):
    fp = resolve_prosody_path(cwd, row)
    if not fp:
        return None
    try:
        with open(fp, "r", encoding="utf-8") as f:
            payload = json.load(f)
        segments = payload.get("segments") if isinstance(payload, dict) else []
        if not isinstance(segments, list) or not segments:
            return None
        return {
            "transition": transition_score(segments),
            "energy": prosody_energy(segments),
            "segCount": len(segments),
        }
    except Exception:
        return None


def infer_target_strength(row, stats):
    notes = str(row.get("notes") or "").lower()
    transition_note = str(row.get("transition_note") or row.get("transitionNote") or "").lower()
    score = clamp(as_num(row.get("score"), 3.0), 1.0, 5.0)
    target = 0.64
    if has_any(notes, ["robot", "datar", "kurang emosi", "flat"]):
        target -= 0.10
    if has_any(notes, ["patah", "kasar", "terlalu cepat", "berlebihan"]) or "abrupt" in transition_note:
        target += 0.08
    if has_any(notes, ["terlalu lambat", "kurang tegas"]):
        target -= 0.04
    if "flat" in transition_note or "datar" in transition_note:
        target -= 0.05
    tr = as_num(stats.get("transition"), 0.0)
    en = as_num(stats.get("energy"), 0.0)
    if tr > 8.5:
        target += 0.06
    if tr < 4.5:
        target -= 0.04
    if en > 20:
        target += 0.04
    if en < 8:
        target -= 0.05
    target += (3.0 - score) * 0.015
    return clamp(target, 0.45, 0.9)


def limiter_feature_vector(row, stats, style):
    notes = str(row.get("notes") or "").lower()
    transition_note = str(row.get("transition_note") or row.get("transitionNote") or "").lower()
    score = clamp(as_num(row.get("score"), 3.0), 1.0, 5.0)
    voice_fit = clamp(as_num(row.get("voice_fit") or row.get("voiceFit"), 4.0), 1.0, 5.0)
    intensity = clamp(as_num(row.get("intensity_target") or row.get("intensityTarget"), 0.6), 0.0, 1.0)
    st = str(style or row.get("style") or "natural")
    return [
        as_num(stats.get("transition"), 0.0),
        as_num(stats.get("energy"), 0.0),
        as_num(stats.get("segCount"), 0.0),
        score / 5.0,
        voice_fit / 5.0,
        intensity,
        style_hash(st),
        1.0 if has_any(notes, ["robot", "datar", "flat", "kurang emosi"]) else 0.0,
        1.0 if has_any(notes, ["terlalu cepat", "patah", "kasar", "berlebihan"]) else 0.0,
        1.0 if has_any(notes, ["terlalu lambat", "kurang tegas"]) else 0.0,
        1.0 if "abrupt" in transition_note else 0.0,
        1.0 if ("flat" in transition_note or "datar" in transition_note) else 0.0,
    ]


def build_samples(cwd, rows, style=""):
    key = str(style or "").strip().lower()
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        row_style = str(row.get("style") or "").strip().lower()
        if key and row_style and row_style != key:
            continue
        stats = read_prosody_stats(cwd, row)
        if not stats:
            continue
        feat = limiter_feature_vector(row, stats, row_style or key or "natural")
        target = infer_target_strength(row, stats)
        out.append({"features": feat, "target": [target], "style": row_style or "natural"})
    return out


def solve_linear_system(a, b):
    n = len(a)
    aug = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        pivot = col
        best = abs(aug[col][col])
        for r in range(col + 1, n):
            v = abs(aug[r][col])
            if v > best:
                best = v
                pivot = r
        if best == 0:
            continue
        if pivot != col:
            aug[col], aug[pivot] = aug[pivot], aug[col]
        pv = aug[col][col]
        for j in range(col, n + 1):
            aug[col][j] /= pv
        for r in range(n):
            if r == col:
                continue
            factor = aug[r][col]
            if factor == 0:
                continue
            for j in range(col, n + 1):
                aug[r][j] -= factor * aug[col][j]
    return [aug[i][n] for i in range(n)]


def train_linear(samples, ridge=1e-6):
    xs = []
    ys = []
    for s in samples or []:
        f = s.get("features") or []
        t = s.get("target") or []
        if not f or len(t) != 1:
            continue
        xs.append([1.0] + [as_num(v, 0.0) for v in f])
        ys.append(as_num(t[0], 0.64))
    if len(xs) < 10:
        return {"status": "skipped", "reason": "not_enough_samples", "sampleCount": len(xs)}

    dim = len(xs[0])
    if np is not None:
        x = np.asarray(xs, dtype=np.float64)
        y = np.asarray(ys, dtype=np.float64).reshape(-1, 1)
        eye = np.eye(dim, dtype=np.float64)
        beta = np.linalg.solve(x.T @ x + max(0.0, ridge) * eye, x.T @ y)
        intercept = float(beta[0, 0])
        weights = [float(v[0]) for v in beta[1:, :].tolist()]
    else:
        xtx = [[0.0 for _ in range(dim)] for _ in range(dim)]
        xty = [0.0 for _ in range(dim)]
        for i in range(len(xs)):
            row = xs[i]
            for a in range(dim):
                va = row[a]
                for b in range(dim):
                    xtx[a][b] += va * row[b]
                xty[a] += va * ys[i]
        for i in range(dim):
            xtx[i][i] += ridge
        beta = solve_linear_system(xtx, xty)
        intercept = float(beta[0])
        weights = [float(v) for v in beta[1:]]

    return {"status": "trained", "sampleCount": len(xs), "intercept": intercept, "weights": weights}


def save_model(path_str, model):
    target = Path(path_str).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        json.dump(model, f, indent=2, ensure_ascii=False)
    return target


def load_model(path_str):
    target = Path(path_str).resolve()
    if not target.exists():
        return None
    with open(target, "r", encoding="utf-8") as f:
        return json.load(f)


def predict_strength(model, feature, fallback=0.64):
    if not isinstance(model, dict):
        return clamp(as_num(fallback, 0.64), 0.45, 0.9)
    model_type = str(model.get("modelType") or "")
    if model_type == "linear_py_v1":
        intercept = as_num(model.get("intercept"), fallback)
        weights = model.get("weights") or []
        out = intercept
        for i, x in enumerate(feature or []):
            if i >= len(weights):
                break
            out += as_num(weights[i], 0.0) * as_num(x, 0.0)
        return clamp(out, 0.45, 0.9)
    return clamp(as_num(fallback, 0.64), 0.45, 0.9)


def summarize_rows_for_style(cwd, rows, style=""):
    key = str(style or "").strip().lower()
    picked = []
    for r in rows or []:
        rs = str((r or {}).get("style") or "").strip().lower()
        if key and rs and rs != key:
            continue
        picked.append(r)
    if not picked:
        return None
    stats = []
    for row in picked:
        st = read_prosody_stats(cwd, row)
        if st:
            stats.append(st)
    if not stats:
        return None

    def avg_num(vals):
        return (sum(vals) / len(vals)) if vals else 0.0

    return {
        "transition": avg_num([as_num(s.get("transition"), 0.0) for s in stats]),
        "energy": avg_num([as_num(s.get("energy"), 0.0) for s in stats]),
        "segCount": avg_num([as_num(s.get("segCount"), 0.0) for s in stats]),
        "score": avg_num([as_num((r or {}).get("score"), 3.0) for r in picked]),
        "voiceFit": avg_num([as_num((r or {}).get("voice_fit") or (r or {}).get("voiceFit"), 4.0) for r in picked]),
        "intensityTarget": avg_num(
            [as_num((r or {}).get("intensity_target") or (r or {}).get("intensityTarget"), 0.6) for r in picked]
        ),
        "notes": " | ".join([str((r or {}).get("notes") or "") for r in picked]),
        "transitionNote": " | ".join([str((r or {}).get("transition_note") or (r or {}).get("transitionNote") or "") for r in picked]),
        "style": key or str((picked[0] or {}).get("style") or "natural"),
    }


def summary_to_feature(summary):
    if not summary:
        return None
    row = {
        "notes": summary.get("notes"),
        "transition_note": summary.get("transitionNote"),
        "score": summary.get("score"),
        "voice_fit": summary.get("voiceFit"),
        "intensity_target": summary.get("intensityTarget"),
        "style": summary.get("style"),
    }
    stats = {"transition": summary.get("transition"), "energy": summary.get("energy"), "segCount": summary.get("segCount")}
    return limiter_feature_vector(row, stats, summary.get("style"))
