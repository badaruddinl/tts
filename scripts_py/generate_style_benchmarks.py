import json
import os
from datetime import datetime, timezone
from pathlib import Path

from common_pipeline import parse_args


if __name__ == "__main__":
    args = parse_args(os.sys.argv[1:])
    voice = str(args.get("voice") or "id-ID-GadisNeural").strip()
    intensity = float(args.get("intensity") or 1.0)
    raw_styles = str(args.get("styles") or "tegang,natural,sinematik,narator_tegas,melankolis")
    styles = [s.strip() for s in raw_styles.split(",") if s.strip()]
    out_dir = Path(str(args.get("outdir") or "outputs/style_benchmarks_py")).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "voice": voice,
        "intensity": intensity,
        "styles": styles,
        "status": "skipped_audio_generation_python_only",
        "cases": [{"style": s, "status": "skipped"} for s in styles],
    }
    summary = out_dir / "summary.json"
    with open(summary, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    print(f"benchmark_generated={len(styles)} summary={str(summary.relative_to(Path.cwd())).replace('\\\\', '/')}")
