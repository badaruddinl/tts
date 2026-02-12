import argparse
import hashlib
import json
import math
import os
from datetime import datetime, timezone

try:
    import numpy as np
except Exception:
    np = None


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


def as_num(value, fallback=0.0):
    try:
        n = float(value)
        if math.isfinite(n):
            return n
    except Exception:
        pass
    return fallback


def pick_num(row, snake_key, camel_key="", fallback=0.0):
    v = row.get(snake_key)
    if v is None and camel_key:
        v = row.get(camel_key)
    return as_num(v, fallback)


def count_letters(text):
    return sum(1 for c in text if ("a" <= c <= "z") or ("A" <= c <= "Z"))


def count_upper(text):
    return sum(1 for c in text if "A" <= c <= "Z")


def has_digit(text):
    return 1.0 if any(c.isdigit() for c in text) else 0.0


def punct_flags(text):
    t = text or ""
    return {
        "q": 1.0 if t.endswith("?") else 0.0,
        "x": 1.0 if t.endswith("!") else 0.0,
        "e": 1.0 if t.endswith("...") else 0.0,
        "d": 1.0 if t.endswith(".") else 0.0,
    }


def style_hash(style):
    h = 0
    s = str(style or "natural")
    for ch in s:
        h = (h * 31 + ord(ch)) % 997
    return h / 997.0


def feature_vector(segment, idx, total, style):
    text = str(segment.get("text", "") or "")
    punct = punct_flags(text)
    letters = count_letters(text)
    upper = count_upper(text)
    upper_ratio = (upper / letters) if letters > 0 else 0.0
    words = len(text.strip().split()) if text.strip() else 0
    pos = (idx / (total - 1)) if total > 1 else 0.0
    return [
        float(len(text)),
        float(words),
        punct["d"],
        punct["q"],
        punct["x"],
        punct["e"],
        upper_ratio,
        has_digit(text),
        pos,
        math.sin(pos * math.pi),
        math.cos(pos * math.pi),
        as_num(segment.get("rate"), 0.0),
        as_num(segment.get("pitch"), 0.0),
        as_num(segment.get("volume"), 0.0),
        style_hash(style),
    ]


def filter_with_adjust(rows):
    out = []
    for r in rows:
        rr = as_num(r.get("adjustRate"), 0.0)
        pp = as_num(r.get("adjustPitch"), 0.0)
        vv = as_num(r.get("adjustVolume"), 0.0)
        if rr != 0 or pp != 0 or vv != 0:
            out.append(r)
    return out


def resolve_prosody_path(cwd, row):
    p = row.get("prosodyFile")
    if not p:
        return None
    target = os.path.abspath(os.path.join(cwd, "outputs", p))
    return target if os.path.exists(target) else None


def safe_stat(file_path):
    try:
        st = os.stat(file_path)
        return {"mtimeMs": int(st.st_mtime * 1000), "size": int(st.st_size)}
    except Exception:
        return {"mtimeMs": 0, "size": 0}


def build_samples(cwd, feedback_rows):
    samples = []
    for row in feedback_rows:
        file_path = resolve_prosody_path(cwd, row)
        if not file_path:
            continue
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                prosody = json.load(f)
        except Exception:
            continue
        segments = prosody.get("segments") if isinstance(prosody, dict) else []
        if not isinstance(segments, list) or not segments:
            continue

        score = as_num(row.get("score"), 3.0)
        intensity_target = max(0.0, min(1.0, pick_num(row, "intensity_target", "intensityTarget", 0.6)))
        voice_fit = max(1.0, min(5.0, pick_num(row, "voice_fit", "voiceFit", 4.0)))
        conf_base = max(0.4, min(1.2, (6.0 - score) / 3.0))
        conf = conf_base * (0.7 + intensity_target * 0.5) * (0.8 + voice_fit / 10.0)
        base_rate_adj = as_num(row.get("adjustRate"), 0.0)
        base_pitch_adj = as_num(row.get("adjustPitch"), 0.0)
        base_volume_adj = as_num(row.get("adjustVolume"), 0.0)
        style = row.get("style") or prosody.get("style") or "natural"

        total = len(segments)
        for i, seg in enumerate(segments):
            text = str(seg.get("text", "") or "")
            punct_q = text.endswith("?")
            punct_x = text.endswith("!")
            punct_e = text.endswith("...")

            dr = base_rate_adj
            dp = base_pitch_adj
            dv = base_volume_adj
            if punct_q:
                dr += 0.35 * base_rate_adj
                dp += 0.5 * base_pitch_adj
            if punct_x:
                dr += 0.4 * base_rate_adj
                dp += 0.35 * base_pitch_adj
                dv += 0.3 * base_volume_adj
            if punct_e:
                dr -= 0.3 * base_rate_adj
                dp -= 0.2 * base_pitch_adj

            samples.append(
                {
                    "features": feature_vector(seg, i, total, style),
                    "target": [dr * conf, dp * conf, dv * conf],
                }
            )
    return samples


def rows_with_adjust(rows):
    return filter_with_adjust(rows)


def compute_signature(cwd, feedback_file, rows):
    feedback_abs = os.path.abspath(feedback_file)
    st = safe_stat(feedback_abs)
    stats = []
    for row in rows_with_adjust(rows):
        p = resolve_prosody_path(cwd, row)
        if not p:
            continue
        sp = safe_stat(p)
        stats.append(f"{os.path.relpath(p, cwd).replace('\\', '/')}:{sp['mtimeMs']}:{sp['size']}")
    stats.sort()
    raw = json.dumps(
        {
            "feedbackFile": os.path.relpath(feedback_abs, cwd).replace("\\", "/"),
            "feedbackMtimeMs": st["mtimeMs"],
            "feedbackSize": st["size"],
            "feedbackRows": len(rows),
            "prosodyCount": len(stats),
            "prosodyStats": stats,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


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


def train_multi_linear(samples, ridge=1e-6):
    if len(samples) < 8:
        return {"status": "skipped", "reason": "not_enough_samples", "sampleCount": len(samples)}
    fsize = len(samples[0]["features"])
    x = []
    y = []
    for s in samples:
        f = s.get("features", [])
        t = s.get("target", [])
        if len(f) != fsize or len(t) != 3:
            continue
        x.append([1.0] + [as_num(v, 0.0) for v in f])
        y.append([as_num(t[0], 0.0), as_num(t[1], 0.0), as_num(t[2], 0.0)])
    if len(x) < 8:
        return {"status": "skipped", "reason": "not_enough_samples", "sampleCount": len(x)}

    dim = len(x[0])
    if np is not None:
        x_np = np.asarray(x, dtype=np.float64)
        y_np = np.asarray(y, dtype=np.float64)
        # Closed-form ridge: (X^T X + lambda I)^-1 X^T Y
        eye = np.eye(dim, dtype=np.float64)
        xtx = x_np.T @ x_np + max(0.0, ridge) * eye
        xty = x_np.T @ y_np
        beta = np.linalg.solve(xtx, xty)
        intercept = beta[0, :].tolist()
        weights = beta[1:, :].tolist()
    else:
        xtx = [[0.0 for _ in range(dim)] for _ in range(dim)]
        xty = [[0.0, 0.0, 0.0] for _ in range(dim)]
        for i in range(len(x)):
            row = x[i]
            tgt = y[i]
            for a in range(dim):
                va = row[a]
                for b in range(dim):
                    xtx[a][b] += va * row[b]
                xty[a][0] += va * tgt[0]
                xty[a][1] += va * tgt[1]
                xty[a][2] += va * tgt[2]
        for i in range(dim):
            xtx[i][i] += ridge

        beta0 = solve_linear_system(xtx, [r[0] for r in xty])
        beta1 = solve_linear_system(xtx, [r[1] for r in xty])
        beta2 = solve_linear_system(xtx, [r[2] for r in xty])
        intercept = [beta0[0], beta1[0], beta2[0]]
        weights = []
        for i in range(1, dim):
            weights.append([beta0[i], beta1[i], beta2[i]])

    return {
        "status": "trained",
        "sampleCount": len(x),
        "featureSize": fsize,
        "intercept": intercept,
        "weights": weights,
    }


def ensure_parent(file_path):
    parent = os.path.dirname(os.path.abspath(file_path))
    if parent and not os.path.exists(parent):
        os.makedirs(parent, exist_ok=True)


def load_samples_with_cache(cwd, feedback_file, rows, use_cache=True):
    sig = compute_signature(cwd, feedback_file, rows)
    cache_dir = os.path.join(cwd, ".tts-cache", "ml-samples")
    cache_file = os.path.join(cache_dir, f"{sig}_py.json")
    if use_cache and os.path.exists(cache_file):
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                payload = json.load(f)
            samples = payload.get("samples") if isinstance(payload, dict) else []
            if isinstance(samples, list):
                return {
                    "signature": sig,
                    "cachePath": cache_file,
                    "cacheHit": True,
                    "rowsWithAdjust": int(payload.get("rowsWithAdjust", 0)),
                    "samples": samples,
                }
        except Exception:
            pass
    adjusted = rows_with_adjust(rows)
    samples = build_samples(cwd, adjusted)
    if use_cache:
        ensure_parent(cache_file)
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                    "feedbackFile": os.path.relpath(os.path.abspath(feedback_file), cwd).replace("\\", "/"),
                    "signature": sig,
                    "rows": len(rows),
                    "rowsWithAdjust": len(adjusted),
                    "samples": samples,
                },
                f,
                indent=2,
                ensure_ascii=False,
            )
    return {
        "signature": sig,
        "cachePath": cache_file,
        "cacheHit": False,
        "rowsWithAdjust": len(adjusted),
        "samples": samples,
    }


def run_training(
    feedback_file,
    output_model,
    summary_file="",
    style_scope="",
    ridge=1e-6,
    use_cache=True,
):
    cwd = os.getcwd()
    feedback_path = os.path.abspath(feedback_file)
    out_model = os.path.abspath(output_model)
    summary_path = os.path.abspath(summary_file) if summary_file else ""
    style_key = (style_scope or "").strip().lower()

    rows = read_ndjson(feedback_path)
    sample_pack = load_samples_with_cache(cwd, feedback_path, rows, use_cache=use_cache)
    samples = sample_pack["samples"]
    result = train_multi_linear(samples, ridge=max(0.0, ridge))
    if result.get("status") != "trained":
        return {
            "status": "skipped",
            "reason": result.get("reason", "unknown"),
            "sampleCount": int(result.get("sampleCount", 0)),
            "feedbackFile": os.path.relpath(feedback_path, cwd).replace("\\", "/"),
        }

    meta = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sampleCount": int(result["sampleCount"]),
        "sourceFeedbackRows": int(sample_pack["rowsWithAdjust"]),
        "version": "prosody-policy-v1",
        "styleScope": style_key if style_key else "all",
        "feedbackFile": os.path.relpath(feedback_path, cwd).replace("\\", "/"),
        "trainer": "python",
        "backend": "numpy" if np is not None else "pure_python",
        "sampleCache": {
            "signature": sample_pack["signature"],
            "file": os.path.relpath(sample_pack["cachePath"], cwd).replace("\\", "/"),
            "hit": bool(sample_pack["cacheHit"]),
        },
    }
    payload = {
        "modelType": "linear_py_v1",
        "featureSize": int(result["featureSize"]),
        "intercept": result["intercept"],
        "weights": result["weights"],
        "meta": meta,
    }

    ensure_parent(out_model)
    with open(out_model, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    if summary_path:
        ensure_parent(summary_path)
        with open(summary_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "status": "trained",
                    "modelPath": os.path.relpath(out_model, cwd).replace("\\", "/"),
                    "feedbackFile": os.path.relpath(feedback_path, cwd).replace("\\", "/"),
                    "sampleCount": int(result["sampleCount"]),
                    "sourceFeedbackRows": int(sample_pack["rowsWithAdjust"]),
                    "styleScope": style_key if style_key else "all",
                    "trainer": "python",
                    "cacheHit": bool(sample_pack["cacheHit"]),
                },
                f,
                indent=2,
                ensure_ascii=False,
            )
    return {
        "status": "trained",
        "modelPath": out_model,
        "sampleCount": int(result["sampleCount"]),
        "sourceFeedbackRows": int(sample_pack["rowsWithAdjust"]),
        "cacheHit": bool(sample_pack["cacheHit"]),
        "feedbackFile": os.path.relpath(feedback_path, cwd).replace("\\", "/"),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--feedback-file", default="data/training/feedback.ndjson")
    parser.add_argument("--output-model", default="models/prosody-policy-v1.json")
    parser.add_argument("--summary-file", default="")
    parser.add_argument("--style", default="")
    parser.add_argument("--ridge", type=float, default=1e-6)
    parser.add_argument("--no-cache", default="false")
    args = parser.parse_args()
    use_cache = str(args.no_cache).strip().lower() != "true"
    res = run_training(
        feedback_file=args.feedback_file,
        output_model=args.output_model,
        summary_file=args.summary_file,
        style_scope=args.style,
        ridge=args.ridge,
        use_cache=use_cache,
    )
    if res.get("status") != "trained":
        print(f"ML training skipped: {res.get('reason')} ({res.get('sampleCount', 0)} samples)")
        return
    print(f"ML policy trained: {res['modelPath']}")
    print(f"Samples: {res['sampleCount']}")
    print(f"Cache hit: {str(res.get('cacheHit', False)).lower()}")


if __name__ == "__main__":
    main()
