"""Best-effort secret masking for every string that goes into the page."""
import re

_BEARER = re.compile(r"(Bearer\s+)[A-Za-z0-9._~+/=\-]{8,}", re.I)
_PREFIXED = re.compile(
    r"(?<![A-Za-z0-9])(sk-[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"xox[bp]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{12,})")
_KV = re.compile(
    r"""(?i)\b((?:api[_-]?key|token|secret|password)["']?\s*[=:]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;)}\]]{8,})""")
_EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@([A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,})")


def _kv(m):
    v = m.group(2)
    bare = v.strip("\"'")
    # Variables, templates, placeholders and already-masked values are not secrets.
    if bare[:1] in "$<{*%(" or "***" in bare or bare.startswith("process.env") or bare.lower() in ("string", "undefined", "null", "true", "false"):
        return m.group(0)
    if v[0] not in "\"'" and not re.search(r"\d", v):
        return m.group(0)  # unquoted words without digits are almost always identifiers
    q = v[0] if v[0] in "\"'" else ""
    return m.group(1) + q + "***" + q


def redact(s):
    if not s or len(s) < 6:
        return s
    s = _BEARER.sub(r"\1***", s)
    s = _PREFIXED.sub(lambda m: m.group(1)[:4] + "***", s)
    s = _KV.sub(_kv, s)
    return _EMAIL.sub(lambda m: "***@" + m.group(1), s)


def walk(o):
    """Redact every string inside nested dict/list structures (in place for containers)."""
    if isinstance(o, str):
        return redact(o)
    if isinstance(o, list):
        return [walk(x) for x in o]
    if isinstance(o, dict):
        return {k: walk(v) for k, v in o.items()}
    return o
