import argparse
import hashlib
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

from training_db import (
    connect_db,
    default_db_path,
    fetch_feedback_rows,
    insert_metric,
    load_json_artifact_lookup,
    record_training_run,
    register_model_version,
    resolve_source_mode,
    source_label_for_sqlite,
    upsert_recommendation,
)

try:
    import numpy as np
except Exception:
    np = None


def read_ndjson_file(file_path):
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


def _resolve_prosody_payload(cwd, row, prosody_lookup=None):
    file_path = resolve_prosody_path(cwd, row)
    if file_path:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    if isinstance(prosody_lookup, dict):
        by_path = prosody_lookup.get("by_path", {})
        by_name = prosody_lookup.get("by_name", {})
        raw_name = str(row.get("prosodyFile") or "").replace("\\", "/").strip()
        cand = []
        if raw_name:
            cand.append(raw_name)
            if raw_name.startswith("outputs/"):
                cand.append(raw_name)
            else:
                cand.append(f"outputs/{raw_name}")
            cand.append(Path(raw_name).name)
        for k in cand:
            if not k:
                continue
            if k in by_path:
                return by_path[k]
            name = Path(k).name
            if name in by_name:
                return by_name[name]
    return None


def build_samples(cwd, feedback_rows, prosody_lookup=None):
    samples = []
    for row in feedback_rows:
        prosody = _resolve_prosody_payload(cwd, row, prosody_lookup=prosody_lookup)
        if not isinstance(prosody, dict):
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


def compute_signature(cwd, data_source_label, rows, source_stat):
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
            "dataSource": data_source_label,
            "sourceMtimeMs": int(source_stat.get("mtimeMs", 0)),
            "sourceSize": int(source_stat.get("size", 0)),
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


def _resolve_feedback_rows(
    cwd,
    feedback_file,
    db_file,
    feedback_source,
    style_scope="",
):
    db_path = Path(db_file or default_db_path(cwd)).resolve()
    mode = resolve_source_mode(feedback_source, db_path, fallback="ndjson")
    style_key = str(style_scope or "").strip().lower()

    if mode == "sqlite":
        conn = connect_db(db_path, ensure_schema=True)
        source_scope = "style" if style_key else "global"
        rows = fetch_feedback_rows(conn, style=style_key, source_scope=source_scope)
        conn.close()
        label = source_label_for_sqlite(cwd, db_path, style_scope=style_key, source_scope=source_scope)
        return {
            "rows": rows,
            "mode": "sqlite",
            "label": label,
            "sourceStat": safe_stat(str(db_path)),
        }

    feedback_path = os.path.abspath(feedback_file)
    rows = read_ndjson_file(feedback_path)
    label = os.path.relpath(feedback_path, cwd).replace("\\", "/")
    return {
        "rows": rows,
        "mode": "ndjson",
        "label": label,
        "sourceStat": safe_stat(feedback_path),
    }


def load_samples_with_cache(cwd, data_source_label, rows, source_stat, use_cache=True, prosody_lookup=None):
    sig = compute_signature(cwd, data_source_label, rows, source_stat)
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
    samples = build_samples(cwd, adjusted, prosody_lookup=prosody_lookup)
    if use_cache:
        ensure_parent(cache_file)
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                    "dataSource": data_source_label,
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
    db_file="",
    feedback_source="auto",
    ridge=1e-6,
    use_cache=True,
):
    cwd = os.getcwd()
    started_at = datetime.now(timezone.utc).isoformat()
    run_key = f"ml_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}"
    out_model = os.path.abspath(output_model)
    summary_path = os.path.abspath(summary_file) if summary_file else ""
    style_key = (style_scope or "").strip().lower()

    source_pack = _resolve_feedback_rows(
        cwd,
        feedback_file=feedback_file,
        db_file=db_file,
        feedback_source=feedback_source,
        style_scope=style_key,
    )
    rows = source_pack["rows"]
    prosody_lookup = None
    if source_pack["mode"] == "sqlite":
        conn = connect_db(db_file or default_db_path(cwd), ensure_schema=True)
        prosody_lookup = load_json_artifact_lookup(conn, kind="prosody_json")
        conn.close()
    sample_pack = load_samples_with_cache(
        cwd,
        data_source_label=source_pack["label"],
        rows=rows,
        source_stat=source_pack["sourceStat"],
        use_cache=use_cache,
        prosody_lookup=prosody_lookup,
    )
    samples = sample_pack["samples"]
    result = train_multi_linear(samples, ridge=max(0.0, ridge))
    if result.get("status") != "trained":
        conn = connect_db(db_file or default_db_path(cwd), ensure_schema=True)
        record_training_run(
            conn,
            run_key=run_key,
            trainer="python",
            model_name="prosody_policy",
            model_path=os.path.relpath(out_model, cwd).replace("\\", "/"),
            summary_path=os.path.relpath(summary_path, cwd).replace("\\", "/") if summary_path else "",
            data_source=source_pack["label"],
            style_scope=style_key if style_key else "all",
            status="skipped",
            sample_count=int(result.get("sampleCount", 0)),
            started_at=started_at,
            ended_at=datetime.now(timezone.utc).isoformat(),
            raw_payload=result,
        )
        conn.close()
        return {
            "status": "skipped",
            "reason": result.get("reason", "unknown"),
            "sampleCount": int(result.get("sampleCount", 0)),
            "feedbackFile": source_pack["label"],
        }

    meta = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sampleCount": int(result["sampleCount"]),
        "sourceFeedbackRows": int(sample_pack["rowsWithAdjust"]),
        "version": "prosody-policy-v1",
        "styleScope": style_key if style_key else "all",
        "feedbackFile": source_pack["label"],
        "feedbackSource": source_pack["mode"],
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
                    "feedbackFile": source_pack["label"],
                    "feedbackSource": source_pack["mode"],
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

    conn = connect_db(db_file or default_db_path(cwd), ensure_schema=True)
    mv = register_model_version(
        conn,
        model_name="prosody_policy",
        path=os.path.relpath(out_model, cwd).replace("\\", "/"),
        source="python",
        trained_at=meta["createdAt"],
        meta=meta,
    )
    record_training_run(
        conn,
        run_key=run_key,
        trainer="python",
        model_name="prosody_policy",
        model_path=os.path.relpath(out_model, cwd).replace("\\", "/"),
        summary_path=os.path.relpath(summary_path, cwd).replace("\\", "/") if summary_path else "",
        data_source=source_pack["label"],
        style_scope=style_key if style_key else "all",
        status="trained",
        sample_count=int(result["sampleCount"]),
        started_at=started_at,
        ended_at=datetime.now(timezone.utc).isoformat(),
        raw_payload=payload,
    )
    insert_metric(
        conn,
        run_key=run_key,
        metric_key="sample_count",
        metric_value=float(result["sampleCount"]),
        model_version_id=mv["id"],
        metric_payload={"sourceFeedbackRows": int(sample_pack["rowsWithAdjust"])},
    )
    upsert_recommendation(
        conn,
        rec_key="active_prosody_policy",
        rec_value=os.path.relpath(out_model, cwd).replace("\\", "/"),
        reason="latest_ml_training",
        score=float(result["sampleCount"]),
    )
    conn.close()
    return {
        "status": "trained",
        "modelPath": out_model,
        "sampleCount": int(result["sampleCount"]),
        "sourceFeedbackRows": int(sample_pack["rowsWithAdjust"]),
        "cacheHit": bool(sample_pack["cacheHit"]),
        "feedbackFile": source_pack["label"],
        "feedbackSource": source_pack["mode"],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--feedback-file", default="data/training/feedback.ndjson")
    parser.add_argument("--feedback-source", default="auto")
    parser.add_argument("--db-file", default="data/training/training.db")
    parser.add_argument("--output-model", default="models/prosody-policy-v1.json")
    parser.add_argument("--summary-file", default="")
    parser.add_argument("--style", default="")
    parser.add_argument("--ridge", type=float, default=1e-6)
    parser.add_argument("--no-cache", default="false")
    args = parser.parse_args()
    use_cache = str(args.no_cache).strip().lower() != "true"
    res = run_training(
        feedback_file=args.feedback_file,
        feedback_source=args.feedback_source,
        db_file=args.db_file,
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
