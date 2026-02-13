import json
import os
import sqlite3
import hashlib
from pathlib import Path


def default_db_path(cwd=None):
    root = Path(cwd or os.getcwd())
    return (root / "data" / "training" / "training.db").resolve()


def _ensure_parent(file_path):
    Path(file_path).resolve().parent.mkdir(parents=True, exist_ok=True)


def connect_db(db_path, ensure_schema=True):
    target = Path(db_path).resolve()
    _ensure_parent(target)
    conn = sqlite3.connect(str(target))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    if ensure_schema:
        init_schema(conn)
    return conn


def init_schema(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          row_key TEXT NOT NULL UNIQUE,
          scope TEXT NOT NULL,
          style_key TEXT,
          at TEXT,
          job_id TEXT,
          voice TEXT,
          mode TEXT,
          style TEXT,
          profile_file TEXT,
          intensity REAL,
          output_file TEXT,
          prosody_file TEXT,
          source_file TEXT,
          raw_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          row_key TEXT NOT NULL UNIQUE,
          scope TEXT NOT NULL,
          style_key TEXT,
          at TEXT,
          job_id TEXT,
          score REAL,
          notes TEXT,
          adjust_rate REAL,
          adjust_pitch REAL,
          adjust_volume REAL,
          mode TEXT,
          style TEXT,
          humanize_intensity REAL,
          output_file TEXT,
          prosody_file TEXT,
          intent_target TEXT,
          intensity_target REAL,
          transition_note TEXT,
          voice_fit REAL,
          source_file TEXT,
          raw_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS training_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_key TEXT NOT NULL UNIQUE,
          trainer TEXT NOT NULL,
          model_name TEXT NOT NULL,
          model_path TEXT,
          summary_path TEXT,
          data_source TEXT NOT NULL,
          style_scope TEXT,
          status TEXT NOT NULL,
          sample_count INTEGER,
          started_at TEXT,
          ended_at TEXT,
          raw_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS style_feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          row_key TEXT UNIQUE,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          style TEXT NOT NULL,
          voice TEXT,
          score REAL,
          features_json TEXT,
          source_file TEXT,
          raw_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS model_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model_name TEXT NOT NULL,
          version TEXT NOT NULL,
          path TEXT NOT NULL,
          trained_at TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 0,
          source TEXT,
          meta_json TEXT,
          UNIQUE(model_name, version)
        );

        CREATE TABLE IF NOT EXISTS metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model_version_id INTEGER,
          run_key TEXT,
          metric_key TEXT NOT NULL,
          metric_value REAL,
          metric_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS recommendations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rec_key TEXT NOT NULL UNIQUE,
          rec_value TEXT,
          reason TEXT,
          score REAL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS auto_train_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          row_key TEXT NOT NULL UNIQUE,
          at TEXT,
          run_id TEXT,
          promote INTEGER,
          dry_run INTEGER,
          source_file TEXT,
          raw_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS ml_split_rows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          row_key TEXT NOT NULL,
          split_name TEXT NOT NULL,
          source_file TEXT,
          raw_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(row_key, split_name)
        );

        CREATE TABLE IF NOT EXISTS ml_split_meta (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_file TEXT NOT NULL UNIQUE,
          meta_json TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS model_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL UNIQUE,
          file_size INTEGER NOT NULL,
          mtime_ms INTEGER NOT NULL,
          sha1 TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS json_artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          mtime_ms INTEGER NOT NULL,
          sha1 TEXT,
          content_text TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_scope_style ON jobs(scope, style_key);
        CREATE INDEX IF NOT EXISTS idx_jobs_job_id ON jobs(job_id);
        CREATE INDEX IF NOT EXISTS idx_feedback_scope_style ON feedback(scope, style_key);
        CREATE INDEX IF NOT EXISTS idx_feedback_style ON feedback(style);
        CREATE INDEX IF NOT EXISTS idx_feedback_job_id ON feedback(job_id);
        CREATE INDEX IF NOT EXISTS idx_style_feedback_style ON style_feedback(style);
        CREATE INDEX IF NOT EXISTS idx_model_versions_name_active ON model_versions(model_name, is_active);
        CREATE INDEX IF NOT EXISTS idx_metrics_run_key ON metrics(run_key);
        CREATE INDEX IF NOT EXISTS idx_auto_train_runs_run_id ON auto_train_runs(run_id);
        CREATE INDEX IF NOT EXISTS idx_ml_split_rows_split_name ON ml_split_rows(split_name);
        CREATE INDEX IF NOT EXISTS idx_json_artifacts_kind ON json_artifacts(kind);
        """
    )
    # Lightweight schema migration for existing DB files.
    style_cols = {str(r["name"]) for r in conn.execute("PRAGMA table_info(style_feedback)").fetchall()}
    if "row_key" not in style_cols:
        conn.execute("ALTER TABLE style_feedback ADD COLUMN row_key TEXT")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_style_feedback_row_key ON style_feedback(row_key)")
    conn.commit()


def read_ndjson(file_path):
    target = Path(file_path)
    if not target.exists():
        return []
    out = []
    with open(target, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                continue
    return out


def _rel(path_like, cwd):
    try:
        p = Path(path_like).resolve()
        return str(p.relative_to(Path(cwd).resolve())).replace("\\", "/")
    except Exception:
        return str(path_like).replace("\\", "/")


def _row_key(scope, style_key, source_file, row):
    canon = {
        "scope": str(scope or "").strip().lower(),
        "style_key": str(style_key or "").strip().lower(),
        "source_file": str(source_file or "").replace("\\", "/"),
        "row": row,
    }
    return json.dumps(canon, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _as_float(value, fallback=None):
    try:
        n = float(value)
        if n != n:
            return fallback
        return n
    except Exception:
        return fallback


def insert_jobs(conn, rows, scope="global", style_key="", source_file=""):
    sql = """
    INSERT OR IGNORE INTO jobs(
      row_key, scope, style_key, at, job_id, voice, mode, style, profile_file,
      intensity, output_file, prosody_file, source_file, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    inserted = 0
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        key = _row_key(scope, style_key, source_file, row)
        style = str(row.get("style") or style_key or "").strip() or None
        payload = (
            key,
            str(scope or "global"),
            str(style_key or "") or None,
            row.get("at"),
            row.get("jobId") or row.get("job_id"),
            row.get("voice"),
            row.get("mode"),
            style,
            row.get("profileFile") or row.get("profile_file"),
            _as_float(row.get("intensity")),
            row.get("outputFile") or row.get("output_file"),
            row.get("prosodyFile") or row.get("prosody_file"),
            str(source_file or "") or None,
            json.dumps(row, ensure_ascii=False),
        )
        cur = conn.execute(sql, payload)
        if int(cur.rowcount or 0) > 0:
            inserted += 1
    conn.commit()
    return inserted


def insert_feedback(conn, rows, scope="global", style_key="", source_file=""):
    sql = """
    INSERT OR IGNORE INTO feedback(
      row_key, scope, style_key, at, job_id, score, notes,
      adjust_rate, adjust_pitch, adjust_volume,
      mode, style, humanize_intensity, output_file, prosody_file,
      intent_target, intensity_target, transition_note, voice_fit,
      source_file, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    inserted = 0
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        key = _row_key(scope, style_key, source_file, row)
        style = str(row.get("style") or style_key or "").strip() or None
        payload = (
            key,
            str(scope or "global"),
            str(style_key or "") or None,
            row.get("at"),
            row.get("jobId") or row.get("job_id"),
            _as_float(row.get("score")),
            row.get("notes"),
            _as_float(row.get("adjustRate") if row.get("adjustRate") is not None else row.get("adjust_rate")),
            _as_float(row.get("adjustPitch") if row.get("adjustPitch") is not None else row.get("adjust_pitch")),
            _as_float(row.get("adjustVolume") if row.get("adjustVolume") is not None else row.get("adjust_volume")),
            row.get("mode"),
            style,
            _as_float(row.get("humanizeIntensity") if row.get("humanizeIntensity") is not None else row.get("humanize_intensity")),
            row.get("outputFile") or row.get("output_file"),
            row.get("prosodyFile") or row.get("prosody_file"),
            row.get("intent_target") or row.get("intentTarget"),
            _as_float(row.get("intensity_target") if row.get("intensity_target") is not None else row.get("intensityTarget")),
            row.get("transition_note") or row.get("transitionNote"),
            _as_float(row.get("voice_fit") if row.get("voice_fit") is not None else row.get("voiceFit")),
            str(source_file or "") or None,
            json.dumps(row, ensure_ascii=False),
        )
        cur = conn.execute(sql, payload)
        if int(cur.rowcount or 0) > 0:
            inserted += 1
    conn.commit()
    return inserted


def insert_style_feedback(conn, rows, source_file=""):
    sql = """
    INSERT OR IGNORE INTO style_feedback(
      row_key, created_at, style, voice, score, features_json, source_file, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """
    inserted = 0
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        style = str(row.get("style") or "").strip().lower()
        if not style:
            continue
        voice = row.get("voice")
        features = row.get("features")
        if features is None:
            features = {
                "adjustRate": row.get("adjustRate") if row.get("adjustRate") is not None else row.get("adjust_rate"),
                "adjustPitch": row.get("adjustPitch") if row.get("adjustPitch") is not None else row.get("adjust_pitch"),
                "adjustVolume": row.get("adjustVolume")
                if row.get("adjustVolume") is not None
                else row.get("adjust_volume"),
                "intent_target": row.get("intent_target") or row.get("intentTarget"),
                "intensity_target": row.get("intensity_target")
                if row.get("intensity_target") is not None
                else row.get("intensityTarget"),
                "transition_note": row.get("transition_note") or row.get("transitionNote"),
                "humanizeIntensity": row.get("humanizeIntensity")
                if row.get("humanizeIntensity") is not None
                else row.get("humanize_intensity"),
            }
        payload = (
            _row_key("style_feedback", style, source_file, row),
            row.get("at") or row.get("created_at") or None,
            style,
            voice,
            _as_float(row.get("score")),
            json.dumps(features, ensure_ascii=False),
            str(source_file or "") or None,
            json.dumps(row, ensure_ascii=False),
        )
        conn.execute(sql, payload)
        inserted += 1
    conn.commit()
    return inserted


def _next_model_version(conn, model_name):
    row = conn.execute(
        "SELECT version FROM model_versions WHERE model_name = ? ORDER BY id DESC LIMIT 1",
        (model_name,),
    ).fetchone()
    if not row:
        return "v1"
    raw = str(row["version"] or "").strip().lower()
    if raw.startswith("v"):
        try:
            n = int(raw[1:])
            return f"v{n + 1}"
        except Exception:
            pass
    return "v1"


def register_model_version(
    conn,
    model_name,
    path,
    source="python",
    version="",
    is_active=True,
    trained_at="",
    meta=None,
):
    v = str(version or "").strip() or _next_model_version(conn, model_name)
    conn.execute(
        "UPDATE model_versions SET is_active = 0 WHERE model_name = ?",
        (model_name,),
    )
    conn.execute(
        """
        INSERT INTO model_versions(model_name, version, path, trained_at, is_active, source, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(model_name, version) DO UPDATE SET
          path=excluded.path,
          trained_at=excluded.trained_at,
          is_active=excluded.is_active,
          source=excluded.source,
          meta_json=excluded.meta_json
        """,
        (
            str(model_name),
            v,
            str(path),
            str(trained_at or ""),
            1 if is_active else 0,
            str(source or "python"),
            json.dumps(meta or {}, ensure_ascii=False),
        ),
    )
    row = conn.execute(
        "SELECT id, version FROM model_versions WHERE model_name = ? AND version = ? LIMIT 1",
        (str(model_name), v),
    ).fetchone()
    conn.commit()
    return {"id": int(row["id"]), "version": str(row["version"])}


def record_training_run(
    conn,
    run_key,
    trainer,
    model_name,
    model_path,
    data_source,
    status,
    style_scope="",
    sample_count=None,
    summary_path="",
    started_at="",
    ended_at="",
    raw_payload=None,
):
    conn.execute(
        """
        INSERT INTO training_runs(
          run_key, trainer, model_name, model_path, summary_path, data_source,
          style_scope, status, sample_count, started_at, ended_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_key) DO UPDATE SET
          trainer=excluded.trainer,
          model_name=excluded.model_name,
          model_path=excluded.model_path,
          summary_path=excluded.summary_path,
          data_source=excluded.data_source,
          style_scope=excluded.style_scope,
          status=excluded.status,
          sample_count=excluded.sample_count,
          started_at=excluded.started_at,
          ended_at=excluded.ended_at,
          raw_json=excluded.raw_json
        """,
        (
            str(run_key),
            str(trainer),
            str(model_name),
            str(model_path or ""),
            str(summary_path or ""),
            str(data_source or ""),
            str(style_scope or ""),
            str(status),
            int(sample_count) if sample_count is not None else None,
            str(started_at or ""),
            str(ended_at or ""),
            json.dumps(raw_payload or {}, ensure_ascii=False),
        ),
    )
    conn.commit()


def insert_metric(conn, run_key, metric_key, metric_value=None, metric_payload=None, model_version_id=None):
    conn.execute(
        """
        INSERT INTO metrics(model_version_id, run_key, metric_key, metric_value, metric_json)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            int(model_version_id) if model_version_id is not None else None,
            str(run_key or ""),
            str(metric_key),
            _as_float(metric_value),
            json.dumps(metric_payload or {}, ensure_ascii=False),
        ),
    )
    conn.commit()


def upsert_recommendation(conn, rec_key, rec_value, reason="", score=None):
    conn.execute(
        """
        INSERT INTO recommendations(rec_key, rec_value, reason, score, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(rec_key) DO UPDATE SET
          rec_value=excluded.rec_value,
          reason=excluded.reason,
          score=excluded.score,
          updated_at=CURRENT_TIMESTAMP
        """,
        (
            str(rec_key),
            str(rec_value or ""),
            str(reason or ""),
            _as_float(score),
        ),
    )
    conn.commit()


def insert_auto_train_runs(conn, rows, source_file=""):
    inserted = 0
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        key = _row_key("auto_train_runs", "", source_file, row)
        payload = (
            key,
            row.get("at"),
            row.get("runId") or row.get("run_id"),
            1 if bool(row.get("promote")) else 0,
            1 if bool(row.get("dryRun") if row.get("dryRun") is not None else row.get("dry_run")) else 0,
            str(source_file or "") or None,
            json.dumps(row, ensure_ascii=False),
        )
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO auto_train_runs(
              row_key, at, run_id, promote, dry_run, source_file, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            payload,
        )
        if int(cur.rowcount or 0) > 0:
            inserted += 1
    conn.commit()
    return inserted


def insert_ml_split_rows(conn, rows, split_name, source_file=""):
    inserted = 0
    split = str(split_name or "").strip().lower()
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        key = _row_key("ml_split", split, source_file, row)
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO ml_split_rows(
              row_key, split_name, source_file, raw_json
            ) VALUES (?, ?, ?, ?)
            """,
            (
                key,
                split,
                str(source_file or "") or None,
                json.dumps(row, ensure_ascii=False),
            ),
        )
        if int(cur.rowcount or 0) > 0:
            inserted += 1
    conn.commit()
    return inserted


def upsert_ml_split_meta(conn, source_file, meta_payload):
    conn.execute(
        """
        INSERT INTO ml_split_meta(source_file, meta_json, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(source_file) DO UPDATE SET
          meta_json=excluded.meta_json,
          updated_at=CURRENT_TIMESTAMP
        """,
        (
            str(source_file),
            json.dumps(meta_payload or {}, ensure_ascii=False),
        ),
    )
    conn.commit()


def _sha1_file(file_path):
    h = hashlib.sha1()
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def upsert_model_file(conn, file_path, cwd=None):
    target = Path(file_path).resolve()
    if not target.exists() or not target.is_file():
        return False
    root = Path(cwd or os.getcwd()).resolve()
    rel = str(target.relative_to(root)).replace("\\", "/")
    st = target.stat()
    sha1 = _sha1_file(target)
    conn.execute(
        """
        INSERT INTO model_files(path, file_size, mtime_ms, sha1, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(path) DO UPDATE SET
          file_size=excluded.file_size,
          mtime_ms=excluded.mtime_ms,
          sha1=excluded.sha1,
          updated_at=CURRENT_TIMESTAMP
        """,
        (
            rel,
            int(st.st_size),
            int(st.st_mtime * 1000),
            sha1,
        ),
    )
    conn.commit()
    return True


def upsert_json_artifact(conn, file_path, kind, cwd=None):
    target = Path(file_path).resolve()
    if not target.exists() or not target.is_file():
        return False
    root = Path(cwd or os.getcwd()).resolve()
    rel = str(target.relative_to(root)).replace("\\", "/")
    st = target.stat()
    sha1 = _sha1_file(target)
    with open(target, "r", encoding="utf-8") as f:
        content = f.read()
    conn.execute(
        """
        INSERT INTO json_artifacts(path, kind, file_size, mtime_ms, sha1, content_text, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(path) DO UPDATE SET
          kind=excluded.kind,
          file_size=excluded.file_size,
          mtime_ms=excluded.mtime_ms,
          sha1=excluded.sha1,
          content_text=excluded.content_text,
          updated_at=CURRENT_TIMESTAMP
        """,
        (
            rel,
            str(kind),
            int(st.st_size),
            int(st.st_mtime * 1000),
            sha1,
            content,
        ),
    )
    conn.commit()
    return True


def load_json_artifact_lookup(conn, kind="prosody_json"):
    rows = conn.execute(
        """
        SELECT path, content_text FROM json_artifacts
        WHERE kind = ?
        """,
        (str(kind),),
    ).fetchall()
    by_path = {}
    by_name = {}
    for r in rows:
        p = str(r["path"] if isinstance(r, sqlite3.Row) else r[0])
        raw = str(r["content_text"] if isinstance(r, sqlite3.Row) else r[1])
        try:
            payload = json.loads(raw)
        except Exception:
            continue
        key = p.replace("\\", "/")
        by_path[key] = payload
        name = Path(key).name
        if name and name not in by_name:
            by_name[name] = payload
    return {"by_path": by_path, "by_name": by_name}


def fetch_feedback_rows(conn, style="", source_scope="global"):
    style_key = str(style or "").strip().lower()
    scope = str(source_scope or "global").strip().lower()

    if scope == "style" and style_key:
        rows = conn.execute(
            """
            SELECT * FROM feedback
            WHERE scope='style' AND lower(coalesce(style_key,'')) = ?
            ORDER BY id ASC
            """,
            (style_key,),
        ).fetchall()
        if not rows:
            rows = conn.execute(
                """
                SELECT * FROM feedback
                WHERE scope='global' AND lower(coalesce(style,'')) = ?
                ORDER BY id ASC
                """,
                (style_key,),
            ).fetchall()
    elif style_key:
        rows = conn.execute(
            """
            SELECT * FROM feedback
            WHERE scope='global' AND lower(coalesce(style,'')) = ?
            ORDER BY id ASC
            """,
            (style_key,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM feedback WHERE scope='global' ORDER BY id ASC"
        ).fetchall()

    out = []
    for r in rows:
        out.append(
            {
                "at": r["at"],
                "jobId": r["job_id"],
                "score": r["score"],
                "notes": r["notes"],
                "adjustRate": r["adjust_rate"],
                "adjustPitch": r["adjust_pitch"],
                "adjustVolume": r["adjust_volume"],
                "mode": r["mode"],
                "style": r["style"],
                "humanizeIntensity": r["humanize_intensity"],
                "outputFile": r["output_file"],
                "prosodyFile": r["prosody_file"],
                "intent_target": r["intent_target"],
                "intensity_target": r["intensity_target"],
                "transition_note": r["transition_note"],
                "voice_fit": r["voice_fit"],
            }
        )
    return out


def resolve_source_mode(feedback_source, db_path, fallback="ndjson"):
    mode = str(feedback_source or "auto").strip().lower()
    if mode not in ("auto", "ndjson", "sqlite"):
        return fallback
    if mode == "auto":
        return "sqlite" if Path(db_path).resolve().exists() else fallback
    return mode


def source_label_for_sqlite(cwd, db_path, style_scope="", source_scope="global"):
    rel = _rel(db_path, cwd)
    style_key = str(style_scope or "").strip().lower() or "all"
    return f"sqlite:{rel}#feedback(scope={source_scope},style={style_key})"

