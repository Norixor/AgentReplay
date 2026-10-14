"""Where the session data lives and where output and caches go.

Each registered source (sources.py) has one data root, resolved in this order (first match wins):
  1. its command line option (Source.dir_flag, e.g. --claude-dir / --codex-dir)
  2. its environment variables in order (Source.dir_envs, e.g. AGENT_REPLAY_CLAUDE_DIR then CLAUDE_CONFIG_DIR,
     AGENT_REPLAY_CODEX_DIR then CODEX_HOME)
  3. its default (Source.dir_default, e.g. ~/.claude, ~/.codex)
The output and cache directory is <project>/replays unless AGENT_REPLAY_HOME is set.
Other modules read the attributes of this module at call time, so configure() may be called after import.
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HOME_DIR = CACHE_DIR = INDEX_FILE = HTML_CACHE = ""
DIRS = {}  # source id -> data root


def _env(*names):
    for n in names:
        v = os.environ.get(n)
        if v and v.strip():
            return v.strip()
    return ""


def _path(p):
    return os.path.abspath(os.path.expanduser(p))


def configure(dirs=None, home=None):
    """(Re)compute every location. dirs: {source id: data root}; explicit values beat environment variables, which
    beat the defaults."""
    import sources  # the adapters import this module; ask the registry only at call time
    global HOME_DIR, DIRS, CACHE_DIR, INDEX_FILE, HTML_CACHE
    dirs = dirs or {}
    HOME_DIR = _path(home or _env("AGENT_REPLAY_HOME") or os.path.join(ROOT, "replays"))
    DIRS = {s.id: _path(dirs.get(s.id) or _env(*s.dir_envs) or s.dir_default) for s in sources.all()}
    CACHE_DIR = os.path.join(HOME_DIR, ".cache")
    INDEX_FILE = os.path.join(CACHE_DIR, "index.json")
    HTML_CACHE = os.path.join(CACHE_DIR, "html")


def source_dir(sid):
    """Data root of a source (KeyError for a source registered after the last configure())."""
    return DIRS[sid]


def add_args(ap):
    """Add the data-directory options shared by every command, one per source."""
    import sources
    for s in sources.all():
        ap.add_argument(s.dir_flag, metavar="DIR", dest=s.dir_dest, help=s.dir_help)


def apply_args(args):
    import sources
    configure({s.id: getattr(args, s.dir_dest, None) for s in sources.all()})


configure()
