#!/usr/bin/env python3
"""Collects AI agent quotas, local token/USD costs across providers, listening ports, and system resources."""

import concurrent.futures
import datetime
import glob
import hashlib
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.parse

HOME = os.path.expanduser("~")
CACHE_DIR = os.path.dirname(os.path.abspath(__file__))
COST_CACHE_PATH = os.path.join(CACHE_DIR, "cost-cache.json")
QUOTA_CACHE_PATH = os.path.join(CACHE_DIR, "quota-cache.json")
SNAPSHOT_PATH = os.path.join(CACHE_DIR, "snapshot.json")
OAUTH_MIN_TTL_MS = 180_000

# USD per 1M tokens, aligned with Orca's model pricing table.
PRICING = {
    "claude-fable-5-2": {"input": 8.0, "output": 40.0, "cacheRead": 0.2, "cacheWrite": 10.0, "cacheWrite1h": 16.0},
    "claude-mythos-5-2": {"input": 8.0, "output": 40.0, "cacheRead": 0.2, "cacheWrite": 10.0, "cacheWrite1h": 16.0},
    "claude-fable-5-1": {"input": 10.0, "output": 50.0, "cacheRead": 0.25, "cacheWrite": 12.5, "cacheWrite1h": 20.0},
    "claude-mythos-5-1": {"input": 10.0, "output": 50.0, "cacheRead": 0.25, "cacheWrite": 12.5, "cacheWrite1h": 20.0},
    "claude-fable-5": {"input": 10.0, "output": 50.0, "cacheRead": 1.0, "cacheWrite": 12.5, "cacheWrite1h": 20.0},
    "claude-mythos-5": {"input": 10.0, "output": 50.0, "cacheRead": 1.0, "cacheWrite": 12.5, "cacheWrite1h": 20.0},
    "claude-opus-5-5": {"input": 4.0, "output": 20.0, "cacheRead": 0.2, "cacheWrite": 5.0, "cacheWrite1h": 8.0},
    "claude-opus-5": {"input": 5.0, "output": 25.0, "cacheRead": 0.5, "cacheWrite": 6.25, "cacheWrite1h": 10.0},
    "claude-sonnet-5-5": {"input": 2.0, "output": 10.0, "cacheRead": 0.1, "cacheWrite": 2.5, "cacheWrite1h": 4.0},
    "claude-sonnet-5": {"input": 2.0, "output": 10.0, "cacheRead": 0.2, "cacheWrite": 2.5, "cacheWrite1h": 4.0},
    "claude-opus-4-8": {"input": 5.0, "output": 25.0, "cacheRead": 0.5, "cacheWrite": 6.25, "cacheWrite1h": 10.0},
    "claude-opus-4-7": {"input": 5.0, "output": 25.0, "cacheRead": 0.5, "cacheWrite": 6.25, "cacheWrite1h": 10.0},
    "claude-opus-4-6": {"input": 5.0, "output": 25.0, "cacheRead": 0.5, "cacheWrite": 6.25, "cacheWrite1h": 10.0},
    "claude-opus-4-5": {"input": 5.0, "output": 25.0, "cacheRead": 0.5, "cacheWrite": 6.25, "cacheWrite1h": 10.0},
    "claude-opus-4-1": {"input": 15.0, "output": 75.0, "cacheRead": 1.5, "cacheWrite": 18.75, "cacheWrite1h": 30.0},
    "claude-opus-4": {"input": 15.0, "output": 75.0, "cacheRead": 1.5, "cacheWrite": 18.75, "cacheWrite1h": 30.0},
    "claude-sonnet-4-6": {"input": 3.0, "output": 15.0, "cacheRead": 0.3, "cacheWrite": 3.75, "cacheWrite1h": 6.0},
    "claude-sonnet-4-5": {"input": 3.0, "output": 15.0, "cacheRead": 0.3, "cacheWrite": 3.75, "cacheWrite1h": 6.0},
    "claude-sonnet-4": {"input": 3.0, "output": 15.0, "cacheRead": 0.3, "cacheWrite": 3.75, "cacheWrite1h": 6.0},
    "claude-sonnet-3-7": {"input": 3.0, "output": 15.0, "cacheRead": 0.3, "cacheWrite": 3.75, "cacheWrite1h": 6.0},
    "claude-sonnet-3-5": {"input": 3.0, "output": 15.0, "cacheRead": 0.3, "cacheWrite": 3.75, "cacheWrite1h": 6.0},
    "claude-haiku-5-5": {"input": 0.1, "output": 0.5, "cacheRead": 0.01, "cacheWrite": 0.125, "cacheWrite1h": 0.2},
    "claude-haiku-4-5": {"input": 1.0, "output": 5.0, "cacheRead": 0.1, "cacheWrite": 1.25, "cacheWrite1h": 2.0},
    "claude-haiku-3-5": {"input": 0.8, "output": 4.0, "cacheRead": 0.08, "cacheWrite": 1.0, "cacheWrite1h": 1.6},
    "claude-haiku-3": {"input": 0.25, "output": 1.25, "cacheRead": 0.03, "cacheWrite": 0.3, "cacheWrite1h": 0.5},
}

MODEL_RE = re.compile(r"(fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2})(?![0-9a-z]))?(?![0-9])", re.I)
HARNESS_PREFIXES = (
    "ollama-", "kiro-", "cf-", "cloud-", "nvidia-", "agnes-", "groq-",
    "openrouter/", "local-", "litellm/", "9router/", "deepseek", "qwen", "llama", "nemotron", "gemma",
)


def classify_model(raw):
    """Return ('claude'|'harness'|'synthetic', normalized_model_name)."""
    if not raw or not isinstance(raw, str):
        return "synthetic", "unknown"
    low = raw.lower().strip()
    if not low or low == "unknown" or "synthetic" in low:
        return "synthetic", "<synthetic>"
    # Non-Anthropic / LiteLLM / 9router models live inside symlinked ~/.claude/projects
    if low.startswith(HARNESS_PREFIXES):
        return "harness", low
    is_anthropic = (
        low.startswith("claude-")
        or low.startswith("anthropic/")
        or "anthropic.claude-" in low
    )
    if not is_anthropic:
        return "harness", low
    norm = normalize_model(low)
    return "claude", (norm or low)


def normalize_model(raw):
    if not raw or not isinstance(raw, str):
        return None
    s = raw.lower().strip().replace(".", "-")
    if s in PRICING:
        return s
    m = MODEL_RE.search(s)
    if m:
        fam, maj, min_v = m.group(1), m.group(2), m.group(3)
        cand = f"claude-{fam}-{maj}" + (f"-{min_v}" if min_v else "")
        if cand in PRICING:
            return cand
        for k in PRICING:
            if k.startswith(f"claude-{fam}-{maj}"):
                return k
        for k in PRICING:
            if f"-{fam}-" in k:
                return k
    if "opus" in s:
        return "claude-opus-5-5"
    if "sonnet" in s:
        return "claude-sonnet-5-5"
    if "haiku" in s:
        return "claude-haiku-5-5"
    if "fable" in s:
        return "claude-fable-5-2"
    return None


def compute_cost(model_raw, usage):
    kind, model_norm = classify_model(model_raw)
    inp = int(usage.get("input_tokens") or 0)
    out = int(usage.get("output_tokens") or 0)
    cread = int(usage.get("cache_read_input_tokens") or 0)
    ccreate = int(usage.get("cache_creation_input_tokens") or 0)
    cc_detail = usage.get("cache_creation") if isinstance(usage.get("cache_creation"), dict) else {}
    c1h = int(cc_detail.get("ephemeral_1h_input_tokens") or 0)
    c5m = max(0, ccreate - c1h)
    tokens = inp + out + cread + ccreate

    if kind != "claude":
        # Harness (Ollama/Kiro/Cloudflare/Agnes/etc.) & <synthetic> must NEVER be billed at Claude fallback rates.
        return kind, model_norm, 0.0, tokens, inp, out, cread, ccreate, c1h

    p = PRICING.get(model_norm)
    if not p:
        return kind, model_norm, 0.0, tokens, inp, out, cread, ccreate, c1h

    cost = (
        (inp * p["input"])
        + (out * p["output"])
        + (cread * p["cacheRead"])
        + (c5m * p["cacheWrite"])
        + (c1h * p["cacheWrite1h"])
    ) / 1_000_000.0
    return kind, model_norm, cost, tokens, inp, out, cread, ccreate, c1h


def format_tier(sub, tier):
    if tier:
        t = tier.lower()
        if "max_20x" in t:
            return "Max 20x"
        if "max_5x" in t:
            return "Max 5x"
        if "max" in t:
            return "Max"
        if "pro" in t:
            return "Pro"
        if "raven" in t or "team" in t:
            return "Team"
        if "enterprise" in t:
            return "Enterprise"
    if sub:
        return sub.capitalize()
    return None


def parse_iso_ms(ts_str):
    if not ts_str:
        return None
    if isinstance(ts_str, (int, float)):
        v = float(ts_str)
        if v <= 0:
            return None
        return int(v * 1000) if v < 1e10 else int(v)
    if not isinstance(ts_str, str):
        return None
    try:
        s = ts_str.replace("Z", "+00:00")
        dt = datetime.datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        ms = int(dt.timestamp() * 1000)
        return ms if ms > 86_400_000 else None
    except Exception:
        return None


def discover_claude_dirs():
    dirs = []
    for p in sorted(glob.glob(os.path.join(HOME, ".claude*"))):
        if os.path.isdir(p):
            base = os.path.basename(p)
            label = "Padrão" if base == ".claude" else base.replace(".claude-", "")
            dirs.append((base, label, p))
    return dirs


def read_claude_creds_for_dir(config_dir, is_default):
    h = hashlib.sha256(config_dir.encode()).hexdigest()[:8]
    svc = "Claude Code-credentials" if is_default else f"Claude Code-credentials-{h}"
    try:
        raw = subprocess.check_output(
            ["security", "find-generic-password", "-s", svc, "-w"],
            stdin=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=4,
        ).strip()
        if raw:
            d = json.loads(raw)
            oauth = d.get("claudeAiOauth") or {}
            if oauth.get("accessToken"):
                return oauth, f"keychain:{svc}"
    except Exception:
        pass
    cred_path = os.path.join(config_dir, ".credentials.json")
    if os.path.exists(cred_path):
        try:
            d = json.load(open(cred_path, "r", encoding="utf-8"))
            oauth = d.get("claudeAiOauth") or {}
            if oauth.get("accessToken"):
                return oauth, f"file:{cred_path}"
        except Exception:
            pass
    return None, None


def read_claude_settings(config_dir):
    sp = os.path.join(config_dir, "settings.json")
    if not os.path.exists(sp):
        return {}
    try:
        return json.load(open(sp, "r", encoding="utf-8")) or {}
    except Exception:
        return {}


def read_claude_account_meta(config_dir, base):
    cands = [os.path.join(config_dir, ".claude.json")]
    if base == ".claude":
        cands.append(os.path.join(HOME, ".claude.json"))
    else:
        cands.append(os.path.join(HOME, f"{base}.json"))
    for p in cands:
        if os.path.isfile(p):
            try:
                oa = (json.load(open(p, "r", encoding="utf-8")) or {}).get("oauthAccount") or {}
                email = oa.get("emailAddress")
                org = oa.get("organizationName")
                if email or org:
                    return email, org
            except Exception:
                pass
    return None, None


def probe_tcp_url(url_str, timeout=0.35):
    try:
        p = urllib.parse.urlparse(url_str)
        host = p.hostname or "127.0.0.1"
        port = p.port or (443 if p.scheme == "https" else 80)
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def fetch_claude_profile_quota(base, label, config_dir, prev_profile, force=False):
    now_ms = int(time.time() * 1000)

    oauth, source = read_claude_creds_for_dir(config_dir, base == ".claude")
    if not oauth:
        sd = read_claude_settings(config_dir)
        env_sd = sd.get("env") if isinstance(sd.get("env"), dict) else {}
        base_url = env_sd.get("ANTHROPIC_BASE_URL")
        if base_url:
            gw_up = probe_tcp_url(base_url, timeout=0.35)
            router_up = probe_tcp_url("http://127.0.0.1:20128", timeout=0.25)
            model_name = env_sd.get("ANTHROPIC_MODEL") or sd.get("model") or "custom"
            return {
                "profile": base,
                "label": label,
                "kind": "harness",
                "configDir": config_dir,
                "source": f"{base_url} ({model_name})",
                "status": "gateway" if gw_up else "offline",
                "gatewayUp": gw_up,
                "routerUp": router_up,
                "baseUrl": base_url,
                "defaultModel": model_name,
                "plan": f"LiteLLM {'ON' if gw_up else 'OFF'} · {model_name}",
                "updatedAt": now_ms,
            }
        if env_sd.get("CLAUDE_CODE_USE_BEDROCK"):
            region = env_sd.get("AWS_REGION") or "us-east-1"
            return {
                "profile": base,
                "label": label,
                "kind": "bedrock",
                "configDir": config_dir,
                "source": f"AWS Bedrock · {region}",
                "status": "bedrock",
                "plan": f"AWS Bedrock ({region})",
                "updatedAt": now_ms,
            }
        return {
            "profile": base,
            "label": label,
            "kind": "oauth",
            "configDir": config_dir,
            "status": "unavailable",
            "error": "Sem credenciais",
            "updatedAt": now_ms,
        }

    if prev_profile and prev_profile.get("rateLimitedUntilMs", 0) > now_ms:
        return prev_profile

    if (
        not force
        and prev_profile
        and prev_profile.get("status") == "ok"
        and not prev_profile.get("rateLimited")
        and (now_ms - prev_profile.get("lastOkAt", 0)) < OAUTH_MIN_TTL_MS
    ):
        return prev_profile

    plan = format_tier(oauth.get("subscriptionType"), oauth.get("rateLimitTier"))
    tok = oauth["accessToken"]
    try:
        proc = subprocess.run(
            [
                "curl", "-sS", "-i", "--max-time", "10",
                "https://api.anthropic.com/api/oauth/usage",
                "-H", f"Authorization: Bearer {tok}",
                "-H", "anthropic-beta: oauth-2025-04-20",
                "-H", "User-Agent: claude-code/2.1.0",
            ],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=12,
        )
        raw = proc.stdout
        if "\r\n\r\n" in raw:
            hdrs, body = raw.split("\r\n\r\n", 1)
        elif "\n\n" in raw:
            hdrs, body = raw.split("\n\n", 1)
        else:
            hdrs, body = "", raw

        status_line = hdrs.splitlines()[0] if hdrs else ""
        if " 429 " in status_line:
            retry_s = 300
            for ln in hdrs.splitlines():
                if ln.lower().startswith("retry-after:"):
                    try:
                        retry_s = max(60, int(ln.split(":", 1)[1].strip()))
                    except Exception:
                        pass
            if prev_profile and (prev_profile.get("status") == "ok" or prev_profile.get("session")):
                out = dict(prev_profile)
                out["status"] = "ok"
                out["rateLimited"] = True
                out["stale"] = True
                out["rateLimitedUntilMs"] = now_ms + retry_s * 1000
                return out
            return {
                "profile": base,
                "label": label,
                "kind": "oauth",
                "configDir": config_dir,
                "source": source,
                "status": "rate_limited",
                "plan": plan,
                "error": "Rate limit (429)",
                "rateLimitedUntilMs": now_ms + retry_s * 1000,
                "updatedAt": now_ms,
            }

        data = json.loads(body)
        if "error" in data and isinstance(data["error"], dict):
            msg = data["error"].get("message") or "Erro na API Claude"
            if prev_profile and (prev_profile.get("status") == "ok" or prev_profile.get("session")):
                out = dict(prev_profile)
                out["status"] = "ok"
                out["stale"] = True
                out["staleError"] = msg
                return out
            return {
                "profile": base,
                "label": label,
                "kind": "oauth",
                "configDir": config_dir,
                "source": source,
                "status": "error",
                "plan": plan,
                "error": msg,
                "updatedAt": now_ms,
            }

        five = data.get("five_hour") or {}
        seven = data.get("seven_day") or {}
        limits = data.get("limits") or []
        fable = None
        for lim in limits:
            if isinstance(lim, dict) and lim.get("kind") == "weekly_scoped":
                scope_name = ((lim.get("scope") or {}).get("model") or {}).get("display_name") or "Scoped"
                if scope_name.strip().lower() == "fable":
                    fable = {
                        "label": "Fable",
                        "percent": round(float(lim.get("percent") or 0)),
                        "resetsAt": parse_iso_ms(lim.get("resets_at")),
                    }
                    break
        if fable is None and isinstance(data.get("fable_weekly"), dict):
            fw = data["fable_weekly"]
            fable = {
                "label": "Fable",
                "percent": round(float(fw.get("utilization") or fw.get("used_percentage") or 0)),
                "resetsAt": parse_iso_ms(fw.get("resets_at")),
            }

        breakdown = []
        for row in (data.get("seven_day_breakdown") or {}).get("rows") or []:
            if isinstance(row, dict):
                breakdown.append({
                    "name": row.get("display_name") or row.get("key"),
                    "percent": row.get("percent", 0),
                    "percentOfLimit": row.get("percent_of_limit", 0),
                })

        extra = data.get("extra_usage") or {}
        spend = data.get("spend") or {}

        return {
            "profile": base,
            "label": label,
            "kind": "oauth",
            "configDir": config_dir,
            "source": source,
            "status": "ok",
            "plan": plan,
            "session": {
                "label": "5h",
                "percent": round(float(five.get("utilization") or 0)),
                "resetsAt": parse_iso_ms(five.get("resets_at")),
            } if five else None,
            "weekly": {
                "label": "sem",
                "percent": round(float(seven.get("utilization") or 0)),
                "resetsAt": parse_iso_ms(seven.get("resets_at")),
            } if seven else None,
            "fable": fable,
            "breakdown": breakdown,
            "extraUsageEnabled": bool(extra.get("is_enabled") or spend.get("enabled")),
            "updatedAt": now_ms,
            "lastOkAt": now_ms,
            "rateLimited": False,
            "stale": False,
        }
    except Exception as exc:
        if prev_profile and (prev_profile.get("status") == "ok" or prev_profile.get("session")):
            out = dict(prev_profile)
            out["status"] = "ok"
            out["stale"] = True
            out["staleError"] = str(exc)
            return out
        return {
            "profile": base,
            "label": label,
            "kind": "oauth",
            "configDir": config_dir,
            "source": source,
            "status": "error",
            "plan": plan,
            "error": str(exc),
            "updatedAt": now_ms,
        }


def fetch_all_claude_profiles(cached_quota, force=False):
    prev_map = {}
    for item in (cached_quota or {}).get("claudeProfiles") or []:
        if isinstance(item, dict) and item.get("profile"):
            prev_map[item["profile"]] = item
    if (cached_quota or {}).get("claude") and ".claude" not in prev_map:
        prev_map[".claude"] = cached_quota["claude"]

    dirs = discover_claude_dirs()
    profiles = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(dirs))) as pool:
        futs = [
            pool.submit(fetch_claude_profile_quota, base, label, p, prev_map.get(base), force)
            for base, label, p in dirs
        ]
        for f in futs:
            profiles.append(f.result())

    for prof in profiles:
        email, org = read_claude_account_meta(prof.get("configDir", ""), prof.get("profile", ""))
        if email:
            prof["email"] = email
        if org:
            prof["org"] = org

    primary = next((x for x in profiles if x["profile"] == ".claude" and x.get("status") == "ok"), None)
    if not primary:
        primary = next((x for x in profiles if x.get("status") == "ok"), None)
    if not primary and profiles:
        primary = profiles[0]
    return primary, profiles


def fetch_antigravity_quota():
    now_ms = int(time.time() * 1000)
    agy_bin = shutil.which("agy") or os.path.join(HOME, ".local", "bin", "agy")
    conv_count = 0
    db_path = os.path.join(HOME, ".gemini", "antigravity-cli", "conversation_summaries.db")
    if os.path.exists(db_path):
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1.0)
            row = conn.execute("SELECT count(*) FROM conversation_summaries").fetchone()
            conv_count = int(row[0]) if row else 0
            conn.close()
        except Exception:
            pass

    if not os.path.exists(agy_bin):
        return {"status": "unavailable", "error": "CLI agy não encontrado", "conversations": conv_count, "updatedAt": now_ms}

    env = dict(os.environ)
    env["AGY_CLI_DISABLE_AUTO_UPDATE"] = "true"
    try:
        proc = subprocess.run(
            [agy_bin, "-p", "/usage", "--output-format", "json", "--print-timeout", "18s"],
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=22,
        )
        payload = None
        for ln in proc.stdout.splitlines():
            s = ln.strip()
            if s.startswith("{"):
                try:
                    obj = json.loads(s)
                    if obj.get("status") == "SUCCESS" and isinstance(obj.get("command"), dict):
                        payload = obj
                        break
                except Exception:
                    continue
        if not payload:
            err = (proc.stderr or proc.stdout or "Sem resposta do agy").strip()[:160]
            return {"status": "error", "error": err, "conversations": conv_count, "updatedAt": now_ms}

        groups_raw = ((payload.get("command") or {}).get("data") or {}).get("groups") or []
        groups = []
        earliest_5h_reset = None
        for g in groups_raw:
            gname = g.get("name") or ""
            short_name = "Gemini" if "gemini" in gname.lower() else ("Claude/GPT" if "claude" in gname.lower() else gname)
            b_5h = None
            b_weekly = None
            for b in g.get("buckets") or []:
                if b.get("disabled"):
                    continue
                rem = b.get("remaining_fraction")
                if not isinstance(rem, (int, float)):
                    continue
                pct = max(0, min(100, round((1.0 - float(rem)) * 100)))
                reset_ms = parse_iso_ms(b.get("reset_time"))
                win = b.get("window")
                entry = {"percent": pct, "resetsAt": reset_ms, "description": b.get("description")}
                if win == "5h":
                    b_5h = entry
                    if reset_ms and (earliest_5h_reset is None or reset_ms < earliest_5h_reset):
                        earliest_5h_reset = reset_ms
                elif win == "weekly":
                    b_weekly = entry
            groups.append({
                "name": gname,
                "shortName": short_name,
                "description": g.get("description") or "",
                "h5": b_5h,
                "weekly": b_weekly,
            })

        agy_model = None
        agy_cfg = os.path.join(HOME, ".gemini", "antigravity-cli", "settings.json")
        if os.path.isfile(agy_cfg):
            try:
                agy_model = (json.load(open(agy_cfg, "r", encoding="utf-8")) or {}).get("model")
            except Exception:
                pass

        return {
            "status": "ok",
            "model": agy_model,
            "groups": groups,
            "resetsAt": earliest_5h_reset,
            "conversations": conv_count,
            "updatedAt": now_ms,
        }
    except Exception as exc:
        return {"status": "error", "error": str(exc), "conversations": conv_count, "updatedAt": now_ms}


def fetch_codex_info():
    now_ms = int(time.time() * 1000)
    codex_dir = os.path.join(HOME, ".codex")
    auth_paths = [os.path.join(codex_dir, "auth.json")] + glob.glob(
        os.path.join(HOME, "Library", "Application Support", "Orca", "codex-accounts", "*", "home", "auth.json")
    )
    auth_data = None
    auth_source = None
    for ap in auth_paths:
        if os.path.exists(ap):
            try:
                d = json.load(open(ap, "r", encoding="utf-8"))
                if (d.get("tokens") or {}).get("access_token"):
                    auth_data = d["tokens"]
                    auth_source = ap
                    break
            except Exception:
                pass

    # Scan Codex sessions JSONL (usually small & few files)
    session_files = sorted(glob.glob(os.path.join(codex_dir, "sessions", "**", "*.jsonl"), recursive=True))
    total_tokens = 0
    total_sessions = len(session_files)
    latest_rate_limit = None
    latest_ts = 0

    for sf in session_files:
        last_total_for_file = 0
        try:
            with open(sf, "r", encoding="utf-8", errors="ignore") as fh:
                for ln in fh:
                    if '"token_count"' not in ln:
                        continue
                    try:
                        obj = json.loads(ln)
                        pl = obj.get("payload") or {}
                        info = pl.get("info") or {}
                        tu = info.get("total_token_usage") or {}
                        t = int(tu.get("total_tokens") or 0)
                        if t > last_total_for_file:
                            last_total_for_file = t
                        rl = pl.get("rate_limits")
                        ts_ms = parse_iso_ms(obj.get("timestamp")) or 0
                        if isinstance(rl, dict) and ts_ms >= latest_ts:
                            latest_ts = ts_ms
                            latest_rate_limit = rl
                    except Exception:
                        continue
        except OSError:
            pass
        total_tokens += last_total_for_file

    if auth_data:
        try:
            hdrs = [
                "-H", f"Authorization: Bearer {auth_data['access_token']}",
                "-H", "User-Agent: codex-cli",
                "-H", "OpenAI-Beta: codex-1",
                "-H", "originator: Codex Desktop",
            ]
            if auth_data.get("account_id"):
                hdrs += ["-H", f"ChatGPT-Account-Id: {auth_data['account_id']}"]
            proc = subprocess.run(
                ["curl", "-sS", "--max-time", "8", "https://chatgpt.com/backend-api/wham/usage"] + hdrs,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=10,
            )
            data = json.loads(proc.stdout)
            if isinstance(data.get("plan_type"), str):
                rl = data.get("rate_limit") or {}
                pw = rl.get("primary_window") or {}
                sw = rl.get("secondary_window") or {}
                return {
                    "status": "ok",
                    "source": "oauth",
                    "authSource": auth_source,
                    "plan": data.get("plan_type"),
                    "session": {
                        "percent": round(float(pw.get("used_percent") or 0)),
                        "resetsAt": parse_iso_ms(pw.get("reset_at")),
                    } if pw else None,
                    "weekly": {
                        "percent": round(float(sw.get("used_percent") or 0)),
                        "resetsAt": parse_iso_ms(sw.get("reset_at")),
                    } if sw else None,
                    "sessionsCount": total_sessions,
                    "totalTokens": total_tokens,
                    "updatedAt": now_ms,
                }
        except Exception as exc:
            pass

    if latest_rate_limit:
        pw = latest_rate_limit.get("primary") or {}
        sw = latest_rate_limit.get("secondary") or {}
        is_pw_weekly = (pw.get("window_minutes") or 0) >= 1440
        return {
            "status": "cached_session",
            "source": "sessions",
            "plan": "Sessão local",
            "session": None if is_pw_weekly else {
                "percent": round(float(pw.get("used_percent") or 0)),
                "resetsAt": parse_iso_ms(pw.get("resets_at")),
            },
            "weekly": {
                "percent": round(float((pw if is_pw_weekly else sw).get("used_percent") or 0)),
                "resetsAt": parse_iso_ms((pw if is_pw_weekly else sw).get("resets_at")),
            } if (is_pw_weekly or sw) else None,
            "sessionsCount": total_sessions,
            "totalTokens": total_tokens,
            "lastSessionAt": latest_ts,
            "updatedAt": now_ms,
        }

    return {
        "status": "unavailable",
        "installed": bool(shutil.which("codex")),
        "sessionsCount": total_sessions,
        "totalTokens": total_tokens,
        "error": "Sem sessão ativa (codex login)",
        "updatedAt": now_ms,
    }


def fetch_opencode_info():
    now_ms = int(time.time() * 1000)
    db_path = os.path.join(HOME, ".local", "share", "opencode", "opencode.db")
    bin_path = shutil.which("opencode") or os.path.join(HOME, ".opencode", "bin", "opencode")
    installed = os.path.exists(bin_path)
    if not os.path.exists(db_path):
        return {"status": "unavailable", "installed": installed, "error": "Banco OpenCode não encontrado", "updatedAt": now_ms}

    today_dt = datetime.date.today()
    today_ms = int(datetime.datetime.combine(today_dt, datetime.time.min).timestamp() * 1000)
    d7_ms = today_ms - 6 * 86400 * 1000
    d30_ms = today_ms - 29 * 86400 * 1000

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1.5)
        rows = conn.execute(
            "SELECT time_created, data FROM message WHERE time_created >= ?",
            (d30_ms,),
        ).fetchall()
        all_row = conn.execute(
            "SELECT count(*), coalesce(sum(json_extract(data,'$.cost')),0), coalesce(sum(json_extract(data,'$.tokens.total')),0) "
            "FROM message WHERE json_extract(data,'$.role')='assistant'"
        ).fetchone()
        sess_row = conn.execute("SELECT count(*) FROM session").fetchone()
        conn.close()

        today_tok, d7_tok, d30_tok = 0, 0, 0
        today_cost, d7_cost, d30_cost = 0.0, 0.0, 0.0
        models = {}
        for ts_ms, raw_data in rows:
            try:
                d = json.loads(raw_data)
            except Exception:
                continue
            if d.get("role") != "assistant":
                continue
            tok = int(((d.get("tokens") or {}).get("total")) or 0)
            cost = float(d.get("cost") or 0.0)
            mod = d.get("modelID") or (d.get("model") or {}).get("modelID") or "opencode"
            if ts_ms >= today_ms:
                today_tok += tok
                today_cost += cost
            if ts_ms >= d7_ms:
                d7_tok += tok
                d7_cost += cost
                models[mod] = models.get(mod, 0) + tok
            d30_tok += tok
            d30_cost += cost

        top_models = [{"name": k, "tokens": v} for k, v in sorted(models.items(), key=lambda x: x[1], reverse=True)[:4]]
        return {
            "status": "ok",
            "installed": installed,
            "sessionsCount": int(sess_row[0]) if sess_row else 0,
            "allTimeMessages": int(all_row[0]) if all_row else 0,
            "allTimeCost": round(float(all_row[1] or 0.0), 2),
            "allTimeTokens": int(all_row[2] or 0),
            "todayTokens": today_tok,
            "todayCost": round(today_cost, 2),
            "d7Tokens": d7_tok,
            "d7Cost": round(d7_cost, 2),
            "d30Tokens": d30_tok,
            "d30Cost": round(d30_cost, 2),
            "topModels7d": top_models,
            "updatedAt": now_ms,
        }
    except Exception as exc:
        return {"status": "error", "installed": installed, "error": str(exc), "updatedAt": now_ms}


def detect_other_providers():
    now_ms = int(time.time() * 1000)
    out = []

    # Gemini CLI (or Antigravity Gemini auth)
    gem_cred = os.path.join(HOME, ".gemini", "oauth_creds.json")
    agy_tok = os.path.join(HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token")
    gem_bin = shutil.which("gemini")
    agy_bin = shutil.which("agy") or os.path.join(HOME, ".local", "bin", "agy")
    has_gem_auth = os.path.exists(gem_cred) or os.path.exists(agy_tok)
    gem_detail = (
        "oauth_creds.json presente"
        if os.path.exists(gem_cred)
        else ("Antigravity OAuth (agy)" if os.path.exists(agy_tok) else "CLI/credenciais não configuradas")
    )
    out.append({
        "id": "gemini",
        "name": "Gemini CLI",
        "icon": "icons/gemini.svg",
        "installed": bool(gem_bin or os.path.exists(agy_bin)),
        "authenticated": has_gem_auth,
        "status": "ready" if has_gem_auth else "unconfigured",
        "detail": gem_detail,
        "updatedAt": now_ms,
    })

    # Kimi
    kimi_cfg = os.path.join(HOME, ".kimi-code", "config.toml")
    kimi_cred = os.path.join(HOME, ".kimi", "credentials")
    kimi_bin = shutil.which("kimi")
    has_kimi_cred = os.path.exists(kimi_cred) and bool(os.listdir(kimi_cred)) if os.path.isdir(kimi_cred) else False
    out.append({
        "id": "kimi",
        "name": "Kimi Code",
        "icon": "icons/kimi.svg",
        "installed": bool(kimi_bin),
        "authenticated": has_kimi_cred,
        "status": "ready" if has_kimi_cred else ("installed" if os.path.exists(kimi_cfg) else "unconfigured"),
        "detail": "Credencial ativa" if has_kimi_cred else ("config.toml presente (sem login)" if os.path.exists(kimi_cfg) else "Não configurado"),
        "updatedAt": now_ms,
    })

    # Grok
    grok_auth = os.path.join(HOME, ".grok", "auth.json")
    grok_dir = os.path.join(HOME, ".grok")
    grok_bin = shutil.which("grok")
    out.append({
        "id": "grok",
        "name": "Grok CLI",
        "icon": "icons/grok.svg",
        "installed": bool(grok_bin),
        "authenticated": os.path.exists(grok_auth),
        "status": "ready" if os.path.exists(grok_auth) else ("installed" if os.path.isdir(grok_dir) else "unconfigured"),
        "detail": "auth.json presente" if os.path.exists(grok_auth) else ("~/.grok presente (sem auth.json)" if os.path.isdir(grok_dir) else "Não configurado"),
        "updatedAt": now_ms,
    })

    # Cursor
    cursor_bin = shutil.which("cursor-agent") or shutil.which("cursor")
    cursor_app = os.path.exists("/Applications/Cursor.app")
    out.append({
        "id": "cursor",
        "name": "Cursor",
        "icon": "icons/cursor.svg",
        "installed": bool(cursor_bin or cursor_app),
        "authenticated": False,
        "status": "installed" if (cursor_bin or cursor_app) else "unconfigured",
        "detail": "App/CLI detectado" if (cursor_bin or cursor_app) else "Não instalado",
        "updatedAt": now_ms,
    })

    return out


def detect_system_locale():
    if sys.platform == "darwin":
        try:
            loc = subprocess.check_output(
                ["defaults", "read", "-g", "AppleLocale"],
                stdin=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=2,
            ).strip()
            if loc:
                return loc
        except Exception:
            pass
    for env_k in ("LC_ALL", "LC_MESSAGES", "LANG"):
        val = os.environ.get(env_k)
        if val:
            return val
    return "en_US"


def inspect_ports():
    ports = []
    if sys.platform == "win32":
        return ports
    try:
        if sys.platform.startswith("linux") and shutil.which("ss"):
            proc = subprocess.run(
                ["ss", "-tlnpH"],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=4,
            )
            seen = set()
            for ln in proc.stdout.splitlines():
                parts = ln.split()
                if len(parts) < 4 or ":" not in parts[3]:
                    continue
                host, port_s = parts[3].rsplit(":", 1)
                if not port_s.isdigit():
                    continue
                port = int(port_s)
                proc_m = re.search(r'"([^"]+)",pid=(\d+)', ln)
                cmd = proc_m.group(1) if proc_m else "process"
                pid = int(proc_m.group(2)) if proc_m else 0
                if (port, pid) in seen:
                    continue
                seen.add((port, pid))
                ports.append({
                    "port": port,
                    "pid": pid,
                    "process": cmd,
                    "user": "",
                    "host": host,
                    "local": host in ("127.0.0.1", "::1", "*", "[::1]", "0.0.0.0"),
                })
            ports.sort(key=lambda x: x["port"])
            return ports

        proc = subprocess.run(
            ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=4,
        )
        seen = set()
        for ln in proc.stdout.splitlines()[1:]:
            parts = ln.split()
            if len(parts) < 9:
                continue
            cmd = parts[0].replace("\\x20", " ")
            pid = int(parts[1]) if parts[1].isdigit() else 0
            user = parts[2]
            addr_raw = parts[-2] if parts[-1] == "(LISTEN)" else parts[-1]
            if ":" not in addr_raw:
                continue
            host, port_s = addr_raw.rsplit(":", 1)
            if not port_s.isdigit():
                continue
            port = int(port_s)
            key = (port, pid)
            if key in seen:
                continue
            seen.add(key)
            ports.append({
                "port": port,
                "pid": pid,
                "process": cmd,
                "user": user,
                "host": host,
                "local": host in ("127.0.0.1", "::1", "*", "[::1]"),
            })
        ports.sort(key=lambda x: x["port"])
    except Exception:
        pass
    return ports


def inspect_system():
    cpu_pct = 0
    mem_used_gb = 0.0
    mem_total_gb = 0.0
    mem_pct = 0
    agents_procs = []

    if sys.platform == "darwin":
        try:
            ncpu = int(subprocess.check_output(["sysctl", "-n", "hw.ncpu"], stdin=subprocess.DEVNULL, text=True, timeout=2).strip() or "1")
            total_bytes = int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], stdin=subprocess.DEVNULL, text=True, timeout=2).strip() or "0")
            mem_total_gb = round(total_bytes / (1024 ** 3), 1)
        except Exception:
            ncpu = 1

        try:
            vm = subprocess.check_output(["vm_stat"], stdin=subprocess.DEVNULL, text=True, timeout=2)
            page_size = 16384
            m_ps = re.search(r"page size of (\d+) bytes", vm)
            if m_ps:
                page_size = int(m_ps.group(1))
            pages = {}
            for ln in vm.splitlines():
                if ":" in ln:
                    k, v = ln.split(":", 1)
                    v = v.strip().rstrip(".")
                    if v.isdigit():
                        pages[k.strip()] = int(v)
            active = pages.get("Pages active", 0)
            wired = pages.get("Pages wired down", 0)
            compressed = pages.get("Pages occupied by compressor", 0)
            used_bytes = (active + wired + compressed) * page_size
            mem_used_gb = round(used_bytes / (1024 ** 3), 1)
            if mem_total_gb > 0:
                mem_pct = min(100, round((mem_used_gb / mem_total_gb) * 100))
        except Exception:
            pass

        try:
            # 2-sample top avoids 0.0% initial delta on macOS
            top_out = subprocess.check_output(["top", "-l", "2", "-s", "0", "-n", "0"], stdin=subprocess.DEVNULL, text=True, timeout=4)
            matches = re.findall(r"CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys", top_out)
            if matches:
                u, s = matches[-1]
                cpu_pct = min(100, round(float(u) + float(s)))
        except Exception:
            pass
    elif sys.platform.startswith("linux"):
        try:
            meminfo = open("/proc/meminfo", "r").read()
            tot_kb = int(re.search(r"MemTotal:\s+(\d+)", meminfo).group(1))
            avail_kb = int(re.search(r"MemAvailable:\s+(\d+)", meminfo).group(1))
            mem_total_gb = round(tot_kb / (1024 ** 2), 1)
            mem_used_gb = round((tot_kb - avail_kb) / (1024 ** 2), 1)
            mem_pct = min(100, round(((tot_kb - avail_kb) / max(1, tot_kb)) * 100))
        except Exception:
            pass
        try:
            load1 = float(open("/proc/loadavg", "r").read().split()[0])
            ncpu = os.cpu_count() or 1
            cpu_pct = min(100, round((load1 / ncpu) * 100))
        except Exception:
            pass

    if sys.platform != "win32":
        try:
            ps_out = subprocess.check_output(
                ["ps", "-axo", "pid=,%cpu=,rss=,args="],
                stdin=subprocess.DEVNULL,
                text=True,
                timeout=3,
            )
            agent_pat = re.compile(r"(?:^|/|\s)(claude|agy|antigravity|opencode|codex|gemini|kimi|grok|herdr-core)(?:\s|$)", re.I)
            total_ps_cpu = 0.0
            for ln in ps_out.splitlines():
                parts = ln.strip().split(None, 3)
                if len(parts) < 4:
                    continue
                pid_s, cpu_s, rss_s, args_str = parts
                if "collect.py" in args_str or "ps -axo" in args_str:
                    continue
                try:
                    c = float(cpu_s)
                    rss_kb = int(rss_s)
                    pid = int(pid_s)
                except ValueError:
                    continue
                total_ps_cpu += c
                m_ag = agent_pat.search(args_str)
                if m_ag:
                    agents_procs.append({
                        "pid": pid,
                        "name": m_ag.group(1).lower(),
                        "cmd": args_str[:72],
                        "cpu": round(c, 1),
                        "memMb": round(rss_kb / 1024),
                    })
            if cpu_pct == 0 and total_ps_cpu > 0:
                cpu_pct = min(100, round(total_ps_cpu / max(1, os.cpu_count() or 1)))
            agents_procs.sort(key=lambda x: (x["memMb"], x["cpu"]), reverse=True)
        except Exception:
            pass

    return {
        "cpuPercent": round(cpu_pct),
        "memUsedGb": mem_used_gb,
        "memTotalGb": mem_total_gb,
        "memPercent": mem_pct,
        "agentProcs": agents_procs[:16],
        "agentProcCount": len(agents_procs),
    }


def decode_project_slug(slug, observed_cwd=None):
    if observed_cwd:
        base = os.path.basename(observed_cwd.rstrip("/"))
        if base:
            return base
    parts = [p for p in slug.split("-") if p]
    return parts[-1] if parts else slug


def scan_claude_costs(days_limit=30):
    now = time.time()
    cutoff = now - days_limit * 86400
    CACHE_VER = 4
    cache = {"version": CACHE_VER, "files": {}}
    if os.path.exists(COST_CACHE_PATH):
        try:
            loaded = json.load(open(COST_CACHE_PATH, "r", encoding="utf-8"))
            if loaded.get("version") == CACHE_VER and isinstance(loaded.get("files"), dict):
                cache = {"version": CACHE_VER, "files": loaded["files"]}
        except Exception:
            pass

    files_cache = cache["files"]
    all_files = []
    seen_real = set()
    for base, label, pdir in discover_claude_dirs():
        for subroot in ("projects", "transcripts"):
            root_dir = os.path.join(pdir, subroot)
            if not os.path.isdir(root_dir):
                continue
            for dirpath, _dirnames, filenames in os.walk(root_dir, followlinks=True):
                for fname in filenames:
                    if not fname.endswith(".jsonl"):
                        continue
                    fpath = os.path.join(dirpath, fname)
                    real = os.path.realpath(fpath)
                    if real in seen_real:
                        continue
                    seen_real.add(real)
                    all_files.append((base, label, fpath, subroot))

    active_paths = set()
    dirty = cache.get("version") != CACHE_VER

    for prof_base, prof_label, fpath, subroot in all_files:
        try:
            st = os.stat(fpath)
        except OSError:
            continue
        if st.st_mtime < cutoff:
            continue
        active_paths.add(fpath)
        prev = files_cache.get(fpath)
        if prev and prev.get("mtime") == st.st_mtime and prev.get("size") == st.st_size and prev.get("profile"):
            continue

        offset = 0
        msgs = {}
        cwd_last = None
        if prev and st.st_size >= prev.get("size", 0) and prev.get("offset", 0) <= st.st_size:
            offset = prev.get("offset", 0)
            msgs = dict(prev.get("msgs") or {})
            cwd_last = prev.get("cwd")

        try:
            with open(fpath, "rb") as fh:
                fh.seek(offset)
                chunk = fh.read()
                new_offset = offset + len(chunk)
        except OSError:
            continue

        for raw_line in chunk.splitlines():
            if b'"usage"' not in raw_line:
                continue
            try:
                obj = json.loads(raw_line)
            except Exception:
                continue
            if isinstance(obj.get("cwd"), str) and obj["cwd"]:
                cwd_last = obj["cwd"]
            msg = obj.get("message")
            if not isinstance(msg, dict):
                continue
            usage = msg.get("usage")
            if not isinstance(usage, dict):
                continue
            ts = obj.get("timestamp")
            if not isinstance(ts, str) or len(ts) < 10:
                continue
            ms = parse_iso_ms(ts)
            if ms is None:
                day = ts[:10]
            else:
                day = datetime.datetime.fromtimestamp(ms / 1000.0).strftime("%Y-%m-%d")

            mid_base = msg.get("id") or obj.get("uuid") or f"{day}:{len(msgs)}"
            req_id = obj.get("requestId")
            mid = f"{mid_base}:{req_id}" if req_id else mid_base
            model_raw = msg.get("model") or "unknown"
            kind, model_norm, cost, tokens, inp, out, cread, ccreate, _c1h = compute_cost(model_raw, usage)
            if kind == "synthetic" and tokens == 0:
                continue

            prev_rec = msgs.get(mid)
            if prev_rec and len(prev_rec) >= 9:
                # Merge streaming updates keeping monotonic token peaks
                inp = max(inp, prev_rec[4])
                out = max(out, prev_rec[5])
                cread = max(cread, prev_rec[6])
                ccreate = max(ccreate, prev_rec[7])
                tokens = max(tokens, prev_rec[3])
                cost = max(round(cost, 6), prev_rec[2])

            msgs[mid] = [day, model_norm, round(cost, 6), tokens, inp, out, cread, ccreate, kind]

        # Extract project slug cleanly whether top-level session or <project>/<sid>/subagents/agent.jsonl
        p_parts = fpath.split(os.sep)
        slug = "outro"
        if subroot in p_parts:
            idx_sr = p_parts.index(subroot)
            if idx_sr + 1 < len(p_parts):
                slug = p_parts[idx_sr + 1]
        files_cache[fpath] = {
            "mtime": st.st_mtime,
            "size": st.st_size,
            "offset": new_offset,
            "cwd": cwd_last,
            "profile": prof_label,
            "project": decode_project_slug(slug, cwd_last),
            "msgs": msgs,
        }
        dirty = True

    for k in list(files_cache.keys()):
        if k not in active_paths:
            del files_cache[k]
            dirty = True

    if dirty:
        try:
            tmp = COST_CACHE_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"version": CACHE_VER, "files": files_cache}, fh)
            os.replace(tmp, COST_CACHE_PATH)
        except Exception:
            pass

    today_dt = datetime.date.today()
    today_str = today_dt.isoformat()
    d7_str = (today_dt - datetime.timedelta(days=6)).isoformat()
    d30_str = (today_dt - datetime.timedelta(days=29)).isoformat()
    d35_str = (today_dt - datetime.timedelta(days=34)).isoformat()

    daily_map = {}
    harness_daily_map = {}
    heatmap_map = {}
    model_map = {}
    harness_model_map = {}
    project_map = {}
    profile_map = {}
    bucket_sessions = {"today": set(), "d7": set(), "d30": set()}
    harness_bucket_sessions = {"today": set(), "d7": set(), "d30": set()}
    totals = {
        "today": {"cost": 0.0, "tokens": 0, "messages": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "zeroCacheTurns": 0, "sessions": 0},
        "d7": {"cost": 0.0, "tokens": 0, "messages": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "zeroCacheTurns": 0, "sessions": 0},
        "d30": {"cost": 0.0, "tokens": 0, "messages": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "zeroCacheTurns": 0, "sessions": 0},
    }
    harness_totals = {
        "today": {"tokens": 0, "messages": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "zeroCacheTurns": 0, "sessions": 0},
        "d7": {"tokens": 0, "messages": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "zeroCacheTurns": 0, "sessions": 0},
        "d30": {"tokens": 0, "messages": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "zeroCacheTurns": 0, "sessions": 0},
    }

    harness_by_profile = {}
    for fpath, fdata in files_cache.items():
        proj = fdata.get("project") or "outro"
        file_prof = fdata.get("profile") or "Padrão"
        parts = fpath.split(os.sep)
        if "subagents" in parts:
            sa_idx = parts.index("subagents")
            sess_id = parts[sa_idx - 1] if sa_idx > 0 else os.path.basename(fpath)
        else:
            sess_id = os.path.splitext(os.path.basename(fpath))[0]

        for rec in (fdata.get("msgs") or {}).values():
            if len(rec) < 9:
                continue
            day, model, cost, tokens, inp, out, cread, ccreate, kind = rec
            if day < d35_str or kind == "synthetic":
                continue

            hm_day = heatmap_map.setdefault(day, {"date": day, "tokens": 0, "cost": 0.0})
            hm_day["tokens"] += tokens

            if kind == "harness":
                h_key = "harness" if file_prof == "Padrão" else file_prof
                hp_tot = harness_by_profile.setdefault(
                    h_key,
                    {"todayTokens": 0, "todayMessages": 0, "d7Tokens": 0, "d7Messages": 0},
                )
                for bucket_key, min_day in (("today", today_str), ("d7", d7_str), ("d30", d30_str)):
                    if day >= min_day:
                        hb = harness_totals[bucket_key]
                        hb["tokens"] += tokens
                        hb["messages"] += 1
                        hb["input"] += inp
                        hb["output"] += out
                        hb["cacheRead"] += cread
                        hb["cacheWrite"] += ccreate
                        if cread == 0:
                            hb["zeroCacheTurns"] += 1
                        harness_bucket_sessions[bucket_key].add(sess_id)
                hdm = harness_daily_map.setdefault(
                    day,
                    {"date": day, "cost": 0.0, "tokens": 0, "messages": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                )
                hdm["tokens"] += tokens
                hdm["messages"] += 1
                hdm["input"] += inp
                hdm["output"] += out
                hdm["cacheRead"] += cread
                hdm["cacheWrite"] += ccreate
                if day == today_str:
                    hp_tot["todayTokens"] += tokens
                    hp_tot["todayMessages"] += 1
                if day >= d7_str:
                    hp_tot["d7Tokens"] += tokens
                    hp_tot["d7Messages"] += 1
                    hm = harness_model_map.setdefault(model, {"name": model, "tokens": 0, "ioTokens": 0, "messages": 0, "_sess": set()})
                    hm["tokens"] += tokens
                    hm["ioTokens"] += (inp + out)
                    hm["messages"] += 1
                    hm["_sess"].add(sess_id)
                    hpm = profile_map.setdefault(h_key, {"name": h_key, "cost7d": 0.0, "todayCost": 0.0, "tokens7d": 0, "messages7d": 0})
                    hpm["tokens7d"] += tokens
                    hpm["messages7d"] += 1
                continue

            hm_day["cost"] += cost
            if day < d30_str:
                continue

            # Genuine Anthropic / Claude API equivalent costs & tokens
            for bucket_key, min_day in (("today", today_str), ("d7", d7_str), ("d30", d30_str)):
                if day >= min_day:
                    b = totals[bucket_key]
                    b["cost"] += cost
                    b["tokens"] += tokens
                    b["messages"] += 1
                    b["input"] += inp
                    b["output"] += out
                    b["cacheRead"] += cread
                    b["cacheWrite"] += ccreate
                    if cread == 0:
                        b["zeroCacheTurns"] += 1
                    bucket_sessions[bucket_key].add(sess_id)

            dm = daily_map.setdefault(
                day,
                {"date": day, "cost": 0.0, "tokens": 0, "messages": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            )
            dm["cost"] += cost
            dm["tokens"] += tokens
            dm["messages"] += 1
            dm["input"] += inp
            dm["output"] += out
            dm["cacheRead"] += cread
            dm["cacheWrite"] += ccreate

            if day >= d7_str:
                pm = project_map.setdefault(proj, {"name": proj, "cost": 0.0, "todayCost": 0.0, "tokens": 0, "ioTokens": 0, "messages": 0, "_sess": set()})
                pm["cost"] += cost
                if day == today_str:
                    pm["todayCost"] += cost
                pm["tokens"] += tokens
                pm["ioTokens"] += (inp + out)
                pm["messages"] += 1
                pm["_sess"].add(sess_id)

                mm = model_map.setdefault(model, {"name": model, "cost": 0.0, "tokens": 0, "ioTokens": 0, "messages": 0, "_sess": set()})
                mm["cost"] += cost
                mm["tokens"] += tokens
                mm["ioTokens"] += (inp + out)
                mm["messages"] += 1
                mm["_sess"].add(sess_id)

                prm = profile_map.setdefault(file_prof, {"name": file_prof, "cost7d": 0.0, "todayCost": 0.0, "tokens7d": 0, "messages7d": 0})
                prm["cost7d"] += cost
                if day == today_str:
                    prm["todayCost"] += cost
                prm["tokens7d"] += tokens
                prm["messages7d"] += 1

    daily_list = []
    harness_daily_list = []
    for i in range(13, -1, -1):
        d = (today_dt - datetime.timedelta(days=i)).isoformat()
        empty_row = {"date": d, "cost": 0.0, "tokens": 0, "messages": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        row = daily_map.get(d, empty_row)
        daily_list.append({
            "date": d,
            "cost": round(row["cost"], 2),
            "tokens": row["tokens"],
            "messages": row["messages"],
            "input": row["input"],
            "output": row["output"],
            "cacheRead": row["cacheRead"],
            "cacheWrite": row["cacheWrite"],
        })
        hrow = harness_daily_map.get(d, empty_row)
        harness_daily_list.append({
            "date": d,
            "cost": 0.0,
            "tokens": hrow["tokens"],
            "messages": hrow["messages"],
            "input": hrow["input"],
            "output": hrow["output"],
            "cacheRead": hrow["cacheRead"],
            "cacheWrite": hrow["cacheWrite"],
        })

    heatmap35 = []
    hm_tokens = [heatmap_map.get((today_dt - datetime.timedelta(days=i)).isoformat(), {}).get("tokens", 0) for i in range(34, -1, -1)]
    max_hm_tok = max([1] + hm_tokens)
    best_day = None
    best_tok = -1
    active_days_30 = 0
    for i in range(34, -1, -1):
        d = (today_dt - datetime.timedelta(days=i)).isoformat()
        hr = heatmap_map.get(d, {"date": d, "tokens": 0, "cost": 0.0})
        t_val = hr["tokens"]
        if d >= d30_str and t_val > 0:
            active_days_30 += 1
        if t_val > best_tok:
            best_tok = t_val
            best_day = {"date": d, "tokens": t_val, "cost": round(hr["cost"], 2)}
        ratio = (t_val / max_hm_tok) if t_val > 0 else 0.0
        lvl = 0 if t_val <= 0 else (1 if ratio < 0.2 else (2 if ratio < 0.45 else (3 if ratio < 0.75 else 4)))
        heatmap35.append({"date": d, "tokens": t_val, "cost": round(hr["cost"], 2), "level": lvl})

    top_projects = sorted(project_map.values(), key=lambda x: x["cost"], reverse=True)[:10]
    for p in top_projects:
        p["cost"] = round(p["cost"], 2)
        p["todayCost"] = round(p["todayCost"], 2)
        p["sessions"] = len(p.pop("_sess", set()))

    top_models = sorted(model_map.values(), key=lambda x: x["cost"], reverse=True)[:8]
    for m in top_models:
        m["cost"] = round(m["cost"], 2)
        m["sessions"] = len(m.pop("_sess", set()))

    top_harness_models = sorted(harness_model_map.values(), key=lambda x: x["tokens"], reverse=True)[:8]
    for hm in top_harness_models:
        hm["sessions"] = len(hm.pop("_sess", set()))

    by_profile = sorted(profile_map.values(), key=lambda x: (x["cost7d"], x["tokens7d"]), reverse=True)
    for pr in by_profile:
        pr["cost7d"] = round(pr["cost7d"], 2)
        pr["todayCost"] = round(pr["todayCost"], 2)

    for bk, b in totals.items():
        b["cost"] = round(b["cost"], 2)
        b["sessions"] = len(bucket_sessions[bk])
        denom = b["input"] + b["cacheRead"]
        b["cacheReusePct"] = round((b["cacheRead"] / denom) * 100, 1) if denom > 0 else 0.0
        b["zeroCachePct"] = round((b["zeroCacheTurns"] / b["messages"]) * 100, 1) if b["messages"] > 0 else 0.0

    for bk, hb in harness_totals.items():
        hb["sessions"] = len(harness_bucket_sessions[bk])
        denom = hb["input"] + hb["cacheRead"]
        hb["cacheReusePct"] = round((hb["cacheRead"] / denom) * 100, 1) if denom > 0 else 0.0
        hb["zeroCachePct"] = round((hb["zeroCacheTurns"] / hb["messages"]) * 100, 1) if hb["messages"] > 0 else 0.0

    return {
        "totals": totals,
        "harness": {
            "totals": harness_totals,
            "daily14": harness_daily_list,
            "byProfile": harness_by_profile,
            "byModel7d": top_harness_models,
        },
        "heatmap35": heatmap35,
        "bestDay": best_day,
        "activeDays30": active_days_30,
        "daily14": daily_list,
        "byProject7d": top_projects,
        "byModel7d": top_models,
        "byProfile7d": by_profile,
        "updatedAt": int(time.time() * 1000),
    }


def main():
    args = sys.argv[1:]
    force = "--force" in args
    mode = next((a for a in args if not a.startswith("-")), "all")

    if mode == "sys":
        print(json.dumps({
            "ports": inspect_ports(),
            "system": inspect_system(),
            "updatedAt": int(time.time() * 1000),
        }))
        return

    if mode == "costs":
        print(json.dumps({"costs": scan_claude_costs(35)}))
        return

    cached_quota = None
    if os.path.exists(QUOTA_CACHE_PATH):
        try:
            cached_quota = json.load(open(QUOTA_CACHE_PATH, "r", encoding="utf-8"))
        except Exception:
            pass

    with concurrent.futures.ThreadPoolExecutor(max_workers=7) as pool:
        f_claude = pool.submit(fetch_all_claude_profiles, cached_quota, force)
        f_agy = pool.submit(fetch_antigravity_quota)
        f_codex = pool.submit(fetch_codex_info)
        f_opencode = pool.submit(fetch_opencode_info)
        f_other = pool.submit(detect_other_providers)
        f_costs = pool.submit(scan_claude_costs, 35)
        f_ports = pool.submit(inspect_ports)
        f_sys = pool.submit(inspect_system)

        claude, claude_profiles = f_claude.result()
        agy = f_agy.result()
        codex = f_codex.result()
        opencode = f_opencode.result()
        others = f_other.result()
        costs = f_costs.result()
        ports = f_ports.result()
        system = f_sys.result()

    h_meta = costs.get("harness") or {}
    h_tot = h_meta.get("totals") or {}
    h_by_prof = h_meta.get("byProfile") or {}
    for prof in claude_profiles:
        if prof.get("kind") == "harness":
            hp = h_by_prof.get(prof.get("label")) or (
                h_by_prof.get("harness") if prof.get("label") == "harness" else None
            )
            if hp:
                prof["todayTokens"] = hp.get("todayTokens", 0)
                prof["todayMessages"] = hp.get("todayMessages", 0)
                prof["d7Tokens"] = hp.get("d7Tokens", 0)
                prof["d7Messages"] = hp.get("d7Messages", 0)
            else:
                prof["todayTokens"] = (h_tot.get("today") or {}).get("tokens", 0)
                prof["todayMessages"] = (h_tot.get("today") or {}).get("messages", 0)
                prof["d7Tokens"] = (h_tot.get("d7") or {}).get("tokens", 0)
                prof["d7Messages"] = (h_tot.get("d7") or {}).get("messages", 0)

    payload = {
        "systemLocale": detect_system_locale(),
        "platform": sys.platform,
        "claude": claude,
        "claudeProfiles": claude_profiles,
        "antigravity": agy,
        "codex": codex,
        "opencode": opencode,
        "others": others,
        "costs": costs,
        "ports": ports,
        "system": system,
        "updatedAt": int(time.time() * 1000),
    }

    try:
        tmp = QUOTA_CACHE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"claude": claude, "claudeProfiles": claude_profiles, "antigravity": agy}, fh)
        os.replace(tmp, QUOTA_CACHE_PATH)
    except Exception:
        pass

    try:
        tmp_s = SNAPSHOT_PATH + ".tmp"
        with open(tmp_s, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        os.replace(tmp_s, SNAPSHOT_PATH)
    except Exception:
        pass

    print(json.dumps(payload))


if __name__ == "__main__":
    main()
