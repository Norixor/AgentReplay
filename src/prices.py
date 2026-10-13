"""Price table loader. prices.json maps model-name fragments to per-million-token quota units."""
import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_CACHE = {}


def load(tool):
    """Return {"models": {fragment: (in, out, cache write, cache read)}, "fallback": fragment|None} for a tool."""
    if not _CACHE:
        try:
            with open(os.path.join(_HERE, "prices.json"), encoding="utf-8") as f:
                _CACHE.update(json.load(f))
        except (OSError, ValueError):
            pass
    cfg = _CACHE.get(tool) or {}
    models = {k: tuple(v) for k, v in (cfg.get("models") or {}).items() if isinstance(v, list) and len(v) == 4}
    return {"models": models, "fallback": cfg.get("fallback")}


def lookup(tool, model):
    """Longest configured fragment contained in the model name; None when the model has no price."""
    cfg = load(tool)
    m = (model or "").lower()
    hits = [k for k in cfg["models"] if k.lower() in m]
    if hits:
        key = max(hits, key=len)
        return key, cfg["models"][key]
    fb = cfg["fallback"]
    if fb and fb in cfg["models"]:
        return fb, cfg["models"][fb]
    return None, None


def cost(prices, u):
    """u = [input, output, cache write, cache read] token counts; prices may be None (unpriced)."""
    if not prices:
        return 0.0
    return (u[0] * prices[0] + u[1] * prices[1] + u[2] * prices[2] + u[3] * prices[3]) / 1e6
