import json
import sys
import time

from train_ml_policy import run_training


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    emit({"type": "ready", "service": "train-ml-policy-py"})
    for line in sys.stdin:
        raw = (line or "").strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except Exception:
            emit({"type": "error", "error": "invalid_json"})
            continue

        if msg.get("action") == "shutdown":
            emit({"type": "bye"})
            return
        if msg.get("action") != "train":
            emit({"id": msg.get("id"), "type": "error", "error": "unknown_action"})
            continue

        t0 = time.perf_counter()
        try:
            res = run_training(
                feedback_file=str(msg.get("feedbackFile") or "data/training/feedback.ndjson"),
                output_model=str(msg.get("outputModel") or "models/prosody-policy-v1.json"),
                summary_file=str(msg.get("summaryFile") or ""),
                style_scope=str(msg.get("style") or ""),
                ridge=float(msg.get("ridge", 1e-6)),
                use_cache=bool(msg.get("useCache", True)),
            )
            emit(
                {
                    "id": msg.get("id"),
                    "type": "result",
                    "elapsedMs": round((time.perf_counter() - t0) * 1000, 3),
                    **res,
                }
            )
        except Exception as err:
            emit(
                {
                    "id": msg.get("id"),
                    "type": "error",
                    "elapsedMs": round((time.perf_counter() - t0) * 1000, 3),
                    "error": str(err),
                }
            )


if __name__ == "__main__":
    main()
