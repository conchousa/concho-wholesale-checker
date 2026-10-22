"""
Concho Wholesale Checker
Look up a wholesale lead in the CLC retailer code list, then check which of the
requested schools Concho is licensed to sell into that retailer's channel.
"""
import json
import os
import pickle
import re
import sqlite3
import threading
from datetime import datetime, timezone
from functools import wraps

import pandas as pd
import hmac
import secrets
from datetime import timedelta

from flask import Flask, Response, jsonify, redirect, request, send_from_directory, session, url_for
from markupsafe import escape
from rapidfuzz import fuzz, process

from channels import CHANNEL_LABELS, TRACKED_CHANNELS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SEED_DIR = os.path.join(BASE_DIR, "data")
# On Render, point DATA_DIR at a persistent disk (e.g. /var/data) so uploads and
# the lead log survive deploys. Locally it falls back to ./data.
DATA_DIR = os.environ.get("DATA_DIR", SEED_DIR)
os.makedirs(DATA_DIR, exist_ok=True)

APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
CLC_EMAIL = os.environ.get("CLC_EMAIL", "")
SENDER_NAME = os.environ.get("SENDER_NAME", "Jake")

FILES = {"retailers": "retailers.xlsx", "channels": "channels.xlsx"}

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config.update(
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("RENDER") is not None or os.environ.get("SECURE_COOKIES") == "1",
)
_lock = threading.Lock()
STATE = {}


# ---------------------------------------------------------------- auth
def signed_in():
    return not APP_PASSWORD or session.get("auth") is True


def requires_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if signed_in():
            return fn(*args, **kwargs)
        if request.path.startswith("/api/"):
            return jsonify({"error": "Not signed in"}), 401
        return redirect(url_for("login", next=request.path))

    return wrapper


LOGIN_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in | Concho Wholesale Checker</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bitter:wght@500;700&family=Public+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/style.css">
<style>
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--paper)}
.login-card{width:100%;max-width:360px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-md);padding:28px}
.login-card .brand{margin-bottom:20px}
.login-card label{display:block;font:600 14px var(--sans);color:var(--ink);margin-bottom:6px}
.login-card input{width:100%;box-sizing:border-box;padding:10px 12px;font:16px var(--sans);border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface);color:var(--ink)}
.login-card input:focus{outline:2px solid var(--saddle);outline-offset:1px}
.login-card button{margin-top:16px;width:100%;padding:11px;font:600 15px var(--sans);color:#fff;background:var(--saddle);border:0;border-radius:var(--radius-sm);cursor:pointer}
.login-err{margin:0 0 14px;padding:9px 12px;border-radius:var(--radius-sm);background:var(--brick-tint);color:var(--brick);font:14px var(--sans)}
</style></head>
<body><div class="login-wrap"><form class="login-card" method="post" action="/login">
<div class="brand"><span class="brand-mark" aria-hidden="true">C</span><div><h1>Wholesale Checker</h1><p class="brand-sub">Concho team sign in</p></div></div>
__ERR__
<input type="hidden" name="next" value="__NEXT__">
<label for="pw">Password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button>
</form></div></body></html>"""


def safe_next(v):
    return v if v and v.startswith("/") and not v.startswith("//") else "/"


@app.route("/login", methods=["GET", "POST"])
def login():
    err = ""
    nxt = safe_next(request.values.get("next", "/"))
    if request.method == "POST":
        pw = request.form.get("password", "")
        if APP_PASSWORD and hmac.compare_digest(pw.encode(), APP_PASSWORD.encode()):
            session.clear()
            session["auth"] = True
            session.permanent = True
            return redirect(nxt)
        err = '<p class="login-err" role="alert">That password didn\'t work. Try again.</p>'
    elif signed_in():
        return redirect(nxt)
    html = LOGIN_HTML.replace("__ERR__", err).replace("__NEXT__", escape(nxt))
    return Response(html, 401 if err else 200, mimetype="text/html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# ---------------------------------------------------------------- data loading
def file_path(kind):
    """Uploaded file in DATA_DIR wins over the seed copy that ships with the repo."""
    uploaded = os.path.join(DATA_DIR, FILES[kind])
    if os.path.exists(uploaded):
        return uploaded
    return os.path.join(SEED_DIR, FILES[kind])


def normalize(name):
    s = str(name).lower()
    s = re.sub(r"\s*-\s*the$", "", s)  # "Frame Connection - The"
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def clean(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    s = str(v).strip()
    return "" if s in ("-", "nan") else s


ACRONYMS = {
    "TCU", "SMU", "LSU", "UTSA", "SFA", "UTEP", "BYU", "ACU", "FAU", "UCF",
    "ECU", "UNLV", "A&M", "ST",
}


def pretty_school(raw):
    def fmt(part):
        out = []
        for w in part.split():
            if w == "UCONN":
                out.append("UConn")
            elif w == "ST":
                out.append("St.")
            elif w in ACRONYMS:
                out.append(w)
            else:
                out.append(w.capitalize())
        return " ".join(out)

    base, _, variant = raw.partition(" - ")
    return f"{fmt(base)} ({fmt(variant)})" if variant else fmt(base)


def read_xlsx(path, **kw):
    try:
        return pd.read_excel(path, engine="calamine", **kw)  # much faster on big files
    except Exception:
        return pd.read_excel(path, **kw)


def parse_retailers(path):
    df = read_xlsx(path, dtype=str)
    cols = {c.strip().lower(): c for c in df.columns}
    need = ["retailer code", "retailer name", "retailer type"]
    missing = [n for n in need if n not in cols]
    if missing:
        raise ValueError(f"Retailer list is missing columns: {', '.join(missing)}")
    df = df[[cols[n] for n in need]]
    df.columns = ["code", "name", "type"]
    df = df.dropna(subset=["code", "name"])
    for c in df.columns:
        df[c] = df[c].fillna("").astype(str).str.strip()
    df["type"] = df["type"].str.upper()
    df["norm"] = df["name"].map(normalize)
    df = df.reset_index(drop=True)
    return df


def parse_channels(path):
    raw = read_xlsx(path, header=None, dtype=object)
    # find the header row (first cell "L" or a row containing the channel codes)
    header_idx = None
    for i, row in raw.iterrows():
        vals = [str(v).strip().upper() for v in row.tolist()]
        if sum(1 for c in TRACKED_CHANNELS if c in vals) >= 4:
            header_idx = i
            break
    if header_idx is None:
        raise ValueError("Couldn't find the channel header row (RRET, SMT, SGSS, BDPT, CAMP, GLFS).")
    header = [str(v).strip().upper() for v in raw.iloc[header_idx].tolist()]
    col = {h: j for j, h in enumerate(header)}
    school_col = 0
    schools = []
    for i in range(header_idx + 1, len(raw)):
        row = raw.iloc[i].tolist()
        name = clean(row[school_col])
        if not name:
            # first blank school cell ends the table (legend lives below it)
            if schools:
                break
            continue
        if name.upper() == "LEGEND":
            break
        flags = {}
        for ch in TRACKED_CHANNELS:
            v = clean(row[col[ch]]).upper() if ch in col else ""
            flags[ch] = v == "YES"
        get = lambda key: clean(row[col[key]]) if key in col else ""
        mark = name.upper()
        parent = mark.split(" - ")[0].strip()
        schools.append(
            {
                "id": mark,
                "name": pretty_school(mark),
                "parent": parent,
                "is_variant": " - " in mark,
                "channels": flags,
                "rate": get("ROYALTY RATE"),
                "licensor": get("LICENSOR"),
                "agreement": get("AGREEMENT"),
                "notes": get("NOTES"),
            }
        )
    if not schools:
        raise ValueError("No schools found under the header row.")
    return schools


def load_kind(kind):
    path = file_path(kind)
    st = os.stat(path)
    cache = os.path.join(DATA_DIR, f".cache_{kind}.pkl")
    key = (path, st.st_size, int(st.st_mtime))
    if os.path.exists(cache):
        try:
            with open(cache, "rb") as f:
                cached_key, data = pickle.load(f)
            if cached_key == key:
                return data, path, st
        except Exception:
            pass
    data = parse_retailers(path) if kind == "retailers" else parse_channels(path)
    try:
        with open(cache, "wb") as f:
            pickle.dump((key, data), f)
    except Exception:
        pass
    return data, path, st


def load_all():
    with _lock:
        r, rpath, rst = load_kind("retailers")
        c, cpath, cst = load_kind("channels")
        STATE["retailers"] = r
        STATE["retailer_norms"] = r["norm"].tolist()
        STATE["code_index"] = {code.upper(): i for i, code in enumerate(r["code"])}
        STATE["schools"] = c
        STATE["school_index"] = {s["id"]: s for s in c}
        STATE["meta"] = {
            "retailers": {
                "rows": int(len(r)),
                "source": "uploaded" if rpath.startswith(DATA_DIR) and DATA_DIR != SEED_DIR else "bundled",
                "updated": datetime.fromtimestamp(rst.st_mtime, timezone.utc).isoformat(),
                "types": r["type"].value_counts().to_dict(),
            },
            "channels": {
                "rows": len(c),
                "source": "uploaded" if cpath.startswith(DATA_DIR) and DATA_DIR != SEED_DIR else "bundled",
                "updated": datetime.fromtimestamp(cst.st_mtime, timezone.utc).isoformat(),
            },
        }


# ---------------------------------------------------------------- lead log (sqlite)
DB_PATH = os.path.join(DATA_DIR, "leads.db")


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS leads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT, updated_at TEXT,
                store_name TEXT, contact_name TEXT, email TEXT, phone TEXT, location TEXT,
                retailer_code TEXT, retailer_name TEXT, channel TEXT,
                schools TEXT, result TEXT, status TEXT, notes TEXT
            )"""
        )


LEAD_FIELDS = [
    "store_name", "contact_name", "email", "phone", "location",
    "retailer_code", "retailer_name", "channel", "status", "notes",
]


def row_to_lead(row):
    d = dict(row)
    d["schools"] = json.loads(d["schools"] or "[]")
    d["result"] = json.loads(d["result"] or "null")
    return d


# ---------------------------------------------------------------- licensing check
CAUTION_WORDS = [
    "only", "named account", "no rights", "not licensed", "outside the grant",
    "limited", "narrower", "no sgss", "no 01p-1",
]


def check_marks(channel, mark_ids):
    channel = (channel or "").upper()
    tracked = channel in TRACKED_CHANNELS
    rows = []
    for mid in mark_ids:
        s = STATE["school_index"].get(mid)
        if not s:
            continue
        warnings = []
        if not tracked:
            status = "review"
        else:
            status = "licensed" if s["channels"].get(channel) else "not_licensed"
        if status == "licensed":
            if not s["rate"]:
                warnings.append("No royalty rate or agreement on file. Confirm with the licensor before invoicing.")
            if s["licensor"].lower() == "affinity" and channel == "GLFS":
                warnings.append(
                    "Affinity has no standalone golf-shop channel. Confirm with Affinity before treating this as approved."
                )
            if s["notes"] and any(w in s["notes"].lower() for w in CAUTION_WORDS):
                warnings.append("Read the license notes. This grant has restrictions.")
        rows.append(
            {
                "id": s["id"],
                "name": s["name"],
                "status": status,
                "rate": s["rate"],
                "licensor": s["licensor"],
                "agreement": s["agreement"],
                "notes": s["notes"],
                "warnings": warnings,
                "other_channels": [c for c in TRACKED_CHANNELS if s["channels"].get(c)],
            }
        )
    licensed = [r for r in rows if r["status"] == "licensed"]
    blocked = [r for r in rows if r["status"] == "not_licensed"]
    if not tracked:
        overall = "review"
    elif rows and len(licensed) == len(rows):
        overall = "ready"
    elif licensed:
        overall = "partial"
    else:
        overall = "not_licensed"
    return {
        "channel": channel,
        "channel_label": CHANNEL_LABELS.get(channel, "Unknown channel"),
        "tracked": tracked,
        "overall": overall,
        "rows": rows,
        "counts": {"licensed": len(licensed), "not_licensed": len(blocked), "total": len(rows)},
    }


# ---------------------------------------------------------------- routes
@app.route("/")
@requires_auth
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/config")
@requires_auth
def config():
    return jsonify(
        {
            "channels": {k: CHANNEL_LABELS.get(k, k) for k in sorted(CHANNEL_LABELS)},
            "tracked": TRACKED_CHANNELS,
            "clc_email": CLC_EMAIL,
            "sender_name": SENDER_NAME,
            "meta": STATE["meta"],
        }
    )


@app.route("/api/schools")
@requires_auth
def schools():
    return jsonify(STATE["schools"])


@app.route("/api/retailers/search")
@requires_auth
def search_retailers():
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"query": q, "results": []})
    df = STATE["retailers"]
    hits = {}

    # exact code match first
    idx = STATE["code_index"].get(q.upper())
    if idx is not None:
        hits[idx] = 101

    nq = normalize(q)
    if nq:
        # substring hits are the most trustworthy signal
        contains = df.index[df["norm"].str.contains(re.escape(nq), regex=True)].tolist()[:200]
        for i in contains:
            hits[i] = max(hits.get(i, 0), 92 if df.at[i, "norm"] != nq else 100)
        for _, score, i in process.extract(
            nq, STATE["retailer_norms"], scorer=fuzz.WRatio, limit=40, score_cutoff=78
        ):
            hits[i] = max(hits.get(i, 0), score)

    ranked = sorted(hits.items(), key=lambda kv: (-kv[1], len(df.at[kv[0], "name"])))[:40]

    # group same-name retailers so "8.28 Boutique" shows both of its codes together
    groups = {}
    for i, score in ranked:
        rec = df.iloc[i]
        g = groups.setdefault(
            rec["norm"], {"name": rec["name"], "score": round(score), "codes": []}
        )
        g["codes"].append(
            {
                "code": rec["code"],
                "type": rec["type"],
                "type_label": CHANNEL_LABELS.get(rec["type"], "Unknown channel"),
                "tracked": rec["type"] in TRACKED_CHANNELS,
            }
        )
    return jsonify({"query": q, "results": list(groups.values())[:25]})


@app.route("/api/check", methods=["POST"])
@requires_auth
def check():
    body = request.get_json(force=True) or {}
    return jsonify(check_marks(body.get("channel"), body.get("schools") or []))


@app.route("/api/leads", methods=["GET", "POST"])
@requires_auth
def leads():
    if request.method == "GET":
        status = request.args.get("status")
        with db() as conn:
            if status:
                rows = conn.execute(
                    "SELECT * FROM leads WHERE status=? ORDER BY updated_at DESC", (status,)
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM leads ORDER BY updated_at DESC").fetchall()
        return jsonify([row_to_lead(r) for r in rows])

    body = request.get_json(force=True) or {}
    now = datetime.now(timezone.utc).isoformat()
    vals = {f: (body.get(f) or "").strip() if isinstance(body.get(f), str) else (body.get(f) or "") for f in LEAD_FIELDS}
    if not vals["store_name"]:
        return jsonify({"error": "Store name is required."}), 400
    schools_json = json.dumps(body.get("schools") or [])
    result_json = json.dumps(body.get("result"))
    with db() as conn:
        if body.get("id"):
            conn.execute(
                f"UPDATE leads SET {', '.join(f + '=?' for f in LEAD_FIELDS)}, schools=?, result=?, updated_at=? WHERE id=?",
                [vals[f] for f in LEAD_FIELDS] + [schools_json, result_json, now, int(body["id"])],
            )
            lead_id = int(body["id"])
        else:
            cur = conn.execute(
                f"INSERT INTO leads ({', '.join(LEAD_FIELDS)}, schools, result, created_at, updated_at) "
                f"VALUES ({', '.join('?' * (len(LEAD_FIELDS) + 4))})",
                [vals[f] for f in LEAD_FIELDS] + [schools_json, result_json, now, now],
            )
            lead_id = cur.lastrowid
        row = conn.execute("SELECT * FROM leads WHERE id=?", (lead_id,)).fetchone()
    return jsonify(row_to_lead(row))


@app.route("/api/leads/<int:lead_id>", methods=["DELETE"])
@requires_auth
def delete_lead(lead_id):
    with db() as conn:
        conn.execute("DELETE FROM leads WHERE id=?", (lead_id,))
    return jsonify({"ok": True})


@app.route("/api/demand")
@requires_auth
def demand():
    """Unlicensed school + channel combos that leads have asked for."""
    with db() as conn:
        rows = conn.execute("SELECT * FROM leads").fetchall()
    combos = {}
    for r in rows:
        lead = row_to_lead(r)
        res = lead["result"] or {}
        for item in res.get("rows", []):
            if item.get("status") != "not_licensed":
                continue
            key = (item["id"], res.get("channel", ""))
            c = combos.setdefault(
                key,
                {
                    "school": item["name"],
                    "school_id": item["id"],
                    "channel": res.get("channel", ""),
                    "channel_label": CHANNEL_LABELS.get(res.get("channel", ""), ""),
                    "count": 0,
                    "stores": [],
                },
            )
            c["count"] += 1
            c["stores"].append({"id": lead["id"], "name": lead["store_name"], "date": lead["created_at"]})
    return jsonify(sorted(combos.values(), key=lambda c: -c["count"]))


@app.route("/api/upload", methods=["POST"])
@requires_auth
def upload():
    kind = request.form.get("kind")
    f = request.files.get("file")
    if kind not in FILES or not f:
        return jsonify({"error": "Pick a file and say whether it's the retailer list or the channels sheet."}), 400
    tmp = os.path.join(DATA_DIR, f".upload_{kind}.xlsx")
    f.save(tmp)
    try:
        parsed = parse_retailers(tmp) if kind == "retailers" else parse_channels(tmp)
    except Exception as e:
        os.remove(tmp)
        return jsonify({"error": f"That file didn't look right: {e}"}), 400
    os.replace(tmp, os.path.join(DATA_DIR, FILES[kind]))
    load_all()
    return jsonify({"ok": True, "rows": len(parsed), "meta": STATE["meta"]})


@app.route("/healthz")
def healthz():
    return "ok"


init_db()
load_all()

if __name__ == "__main__":
    app.run(debug=True, port=int(os.environ.get("PORT", 5000)))
