"""Where the session data lives and where output and caches go.

Resolution order for each Claude Code / Codex data root (first match wins):
  1. command line  --claude-dir / --codex-dir
  2. AGENT_REPLAY_CLAUDE_DIR / AGENT_REPLAY_CODEX_DIR
  3. the tools' own conventions: CLAUDE_CONFIG_DIR, CODEX_HOME
  4. ~/.claude, ~/.codex
The output and cache directory is <project>/replays unless AGENT_REPLAY_HOME is set.
Other modules read the attributes of this module at call time, so configure() may be called after import.
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HOME_DIR = CLAUDE_DIR = CODEX_DIR = ""
CLAUDE_PROJECTS = CLAUDE_SESSIONS = CODEX_SESSIONS = CODEX_ARCHIVED = ""
CACHE_DIR = INDEX_FILE = HTML_CACHE = ""


def _env(*names):
    for n in names:
        v = os.environ.get(n)
        if v and v.strip():
            return v.strip()
    return ""


def _path(p):
    return os.path.abspath(os.path.expanduser(p))


def configure(claude_dir=None, codex_dir=None, home=None):
    """(Re)compute every location. Explicit arguments beat environment variables, which beat the defaults."""
    global HOME_DIR, CLAUDE_DIR, CODEX_DIR, CLAUDE_PROJECTS, CLAUDE_SESSIONS, CODEX_SESSIONS, CODEX_ARCHIVED
    global CACHE_DIR, INDEX_FILE, HTML_CACHE
    HOME_DIR = _path(home or _env("AGENT_REPLAY_HOME") or os.path.join(ROOT, "replays"))
    CLAUDE_DIR = _path(claude_dir or _env("AGENT_REPLAY_CLAUDE_DIR", "CLAUDE_CONFIG_DIR") or os.path.join("~", ".claude"))
    CODEX_DIR = _path(codex_dir or _env("AGENT_REPLAY_CODEX_DIR", "CODEX_HOME") or os.path.join("~", ".codex"))
    CLAUDE_PROJECTS = os.path.join(CLAUDE_DIR, "projects")
    CLAUDE_SESSIONS = os.path.join(CLAUDE_DIR, "sessions")
    CODEX_SESSIONS = os.path.join(CODEX_DIR, "sessions")
    CODEX_ARCHIVED = os.path.join(CODEX_DIR, "archived_sessions")
    CACHE_DIR = os.path.join(HOME_DIR, ".cache")
    INDEX_FILE = os.path.join(CACHE_DIR, "index.json")
    HTML_CACHE = os.path.join(CACHE_DIR, "html")


def add_args(ap):
    """Add the data-directory options shared by every command."""
    ap.add_argument("--claude-dir", metavar="DIR", help="Claude Code 数据目录（含 projects/），默认 $CLAUDE_CONFIG_DIR 或 ~/.claude")
    ap.add_argument("--codex-dir", metavar="DIR", help="Codex 数据目录（含 sessions/），默认 $CODEX_HOME 或 ~/.codex")


def apply_args(args):
    configure(getattr(args, "claude_dir", None), getattr(args, "codex_dir", None))


configure()
