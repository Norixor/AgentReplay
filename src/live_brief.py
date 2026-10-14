"""Call briefs for the live snapshot: the input / result text a feed keeps per call, and the compact form cards carry.

The step brief of the replay page (step_brief.js) turns a call {name, cat, sum, inp, res, st, ...} into "category / action /
result line". Every live feed stores the same fields on its call dicts (limits below, the replay parser's own caps are larger),
and live.Live.card() sends the newest steps' calls with tighter caps so the snapshot stays small. Strings leaving the process
are redacted like the rest of the page (redact.py).
"""
from common import cut
from redact import redact

STORE_INP, STORE_RES = 1500, 600      # kept on the in-memory call dicts
CARD_STEPS, CARD_CALLS = 3, 2         # steps of a card that carry calls, and calls per step
CARD_INP, CARD_RES, CARD_SAID = 360, 240, 240
_BIG = {"content", "old_string", "new_string", "prompt", "message", "text", "contents", "new_str", "old_str", "file_text", "patch"}


def tool_inp(inp, cmd=""):
    """Input text kept for one call: the full shell command, else a short "key: value" listing of the scalar arguments
    (file contents and prompts are left out, they are what makes a call expensive and are not needed for a brief)."""
    if cmd:
        return cmd[:STORE_INP]
    if not isinstance(inp, dict):
        return ""
    out = []
    for k, v in inp.items():
        if k in _BIG or v is None or v == "":
            continue
        out.append("%s: %s" % (k, str(v)[:120].replace("\n", " ")))
    return "\n".join(out)[:STORE_INP]


def res_text(text):
    """Result text kept for one call (the first STORE_RES characters, marked when cut: the same cut the replay parser uses)."""
    return cut(text if isinstance(text, str) else "", STORE_RES)


def card_inp(c):
    """The input a card carries for call dict c: only what "sum" does not already say (a short one-line command is entirely in
    "sum"; other tools' arguments are only read by the brief when "sum" is empty)."""
    inp, cmd = str(c.get("inp") or ""), str(c.get("cmd") or "")
    keep = bool(cmd) and ("\n" in inp or len(inp.strip()) > 200) or not c.get("sum")
    return redact(cut(inp, CARD_INP)) if keep and inp else ""


def _one(c):
    """One call dict of any feed -> the fields step_brief.js reads."""
    inp = card_inp(c)
    # the brief reads the input before the summary, so a call that carries its input needs only the start of the summary
    o = {"name": c.get("name") or "", "cat": c.get("cat") or "other", "sum": redact((c.get("sum") or "")[:80 if inp else 240]), "inp": inp,
         "res": redact(cut(str(c.get("res") or ""), CARD_RES)), "st": c.get("st") or "pend", "ts": c.get("ts") or 0, "dur": c.get("dur") or 0}
    if c.get("bg"):
        o["bg"] = True
    if c.get("rlen"):
        o["rlen"] = c["rlen"]
    if o["st"] == "hook":
        o["hook"] = o["res"][:160]
    return o


def card_calls(step):
    """The calls of one step for a card: at most CARD_CALLS, the unfinished ones first (they are what is happening now)."""
    calls = [c for c in step.get("calls") or [] if isinstance(c, dict)]
    pend = [c for c in calls if (c.get("st") or "pend") == "pend"]
    # identity, not equality: call dicts point back at their step, which lists them
    pick = {id(c) for c in (pend + [c for c in calls if all(c is not p for p in pend)])[:CARD_CALLS]}
    return [_one(c) for c in calls if id(c) in pick]


def said_text(a):
    return redact((a.said or "")[:CARD_SAID])
