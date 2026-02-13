import json
import os
from datetime import datetime, timezone
from pathlib import Path

from common_pipeline import parse_args
from limiter_policy import build_samples, read_ndjson, save_model, train_linear


def main():
    args = parse_args(os.sys.argv[1:])
    cwd = os.getcwd()
    style = str(args.get("style") or "").strip().lower()
    default_feedback = (
        Path(cwd) / "data" / "training" / "styles" / style / "feedback.ndjson"
        if style
        else Path(cwd) / "data" / "training" / "feedback.ndjson"
    )
    feedback_path = Path(str(args.get("feedback-file") or default_feedback)).resolve()
    output_model = Path(str(args.get("output-model") or "models/limiter-policy-v1-py.json")).resolve()
    summary_file = str(args.get("summary-file") or "").strip()
    rows = read_ndjson(str(feedback_path))
    samples = build_samples(cwd, rows, style=style)
    res = train_linear(samples, ridge=1e-6)
    if res.get("status") != "trained":
        print(f"limiter_training_skipped reason={res.get('reason')} samples={res.get('sampleCount', 0)}")
        return

    payload = {
        "modelType": "linear_py_v1",
        "intercept": float(res["intercept"]),
        "weights": [float(v) for v in res["weights"]],
        "meta": {
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "sampleCount": int(res["sampleCount"]),
            "styleScope": style or "all",
            "feedbackFile": str(feedback_path.relative_to(Path(cwd))).replace("\\", "/"),
            "version": "limiter-policy-v1-py",
            "trainer": "python",
        },
    }
    saved = save_model(str(output_model), payload)
    print(
        f"limiter_policy_trained model={str(saved.relative_to(Path(cwd))).replace('\\', '/')} samples={res['sampleCount']}"
    )
    if summary_file:
        sp = Path(summary_file).resolve()
        sp.parent.mkdir(parents=True, exist_ok=True)
        with open(sp, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "status": "trained",
                    "modelPath": str(saved.relative_to(Path(cwd))).replace("\\", "/"),
                    "sampleCount": int(res["sampleCount"]),
                    "styleScope": style or "all",
                },
                f,
                indent=2,
                ensure_ascii=False,
            )


if __name__ == "__main__":
    main()
