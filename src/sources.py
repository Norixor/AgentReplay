"""Session sources (Claude Code, Codex, ...): the registry and the contract every source adapter implements.

The rest of the tool never branches on a source name. Indexing, listing, the CLI, the server routes, parsing, the live
view, the step feed, pricing and the page's source chip all go through the Source object registered under the record's
"tool" field. Adding a source = one adapter module that defines SOURCE (a Source subclass instance) plus its module name
in BUILTIN below.

Contract of a source adapter (class attributes, then methods):

  id              stable key, [a-z0-9_]+. Used as the record / row "tool" field, the URL segment (/s/<id>/<session>,
                  /r/..., /api/open/..., /api/job/..., /api/live/..., /api/steps/...), the row key "<id>:<session id>",
                  cache file names, the prices.json section and the "<id>-<name>-<day>.html" CLI output name.
  label           display name ("Claude Code"): list chip, filter option, loading page, replay page.
  color           CSS background of the source chip (any CSS colour, theme variables such as var(--opus-bg) work).
  default         True for exactly one source: the one assumed when no source's sniff() recognises a file.
  dir_flag        command line option for the data root, e.g. "--claude-dir" (argparse dest = "claude_dir").
  dir_envs        environment variables for the data root, first one set wins, e.g.
                  ("AGENT_REPLAY_CLAUDE_DIR", "CLAUDE_CONFIG_DIR"). The option beats them, they beat dir_default.
  dir_default     default data root, "~" is expanded (e.g. os.path.join("~", ".claude")).
  dir_help        help text of dir_flag.
  ctx_limit_key   live.json key of the context size above which the live view warns, and ctx_limit_default its
                  default (live.py merges these into its defaults, so live.json may override them).
  reparse_gap     minimum seconds between two background re-parses of one in-progress session (step feed).
  page            dict of replay-page hints, embedded as meta.source together with label and color (see render.py):
                  fams (bool: colour models by Claude family names), notes {why, mainSteps, hooks, reasonMissing,
                  lastText}: source-specific explanations shown on the page.

  root                    property: the configured data root (config.source_dir(id)).
  files()                 -> iterable of session file paths to index (every file, sub-agent files included when
                          the source indexes them as records of their own).
  sniff(head)             -> bool: the first 300 bytes of a file belong to this source (used for path arguments).
  scan(path)              -> index record (a dict, JSON-serialisable, cached in index.json). Required keys:
                          tool (= id), path, id, parent (parent record id or None: records whose parent is another
                          record of the same source are not listed on their own), archived (bool), cwd, start, end
                          (ms or None), model, title0. Read only the head and tail of the file; never parse it whole.
  rows(recs, now_ms)      -> list rows of the top-level sessions among `recs` (this source's records only, path ->
                          record with size and mtime added). Build each with scan_util.make_row(); fold sub-agent
                          records / files into its subs, sub_size and mtime. "active" / "archived" status come from
                          make_row (mtime within scan_util.ACTIVE_MS, record archived flag).
  tree(recs, root_id, path)  -> {agent id: file path} of the session, root first: what parse() and the live view read.
  tree_for_path(path, root_id)  -> (root id, tree) when the caller has no index at hand (CLI, render without a tree).
                          The default looks the session up in the index and falls back to {root_id: path}.
  session_files(recs, row)  -> every file whose change must invalidate cached pages and the step feed.
  parse(root_id, tree, name, out_chars, inp_chars, progress=None, cache=None)
                          -> the page data model {"meta", "agents", "totals"} shared by every source (meta.tool = id,
                          meta.pricing = prices.meta(id)). progress(done, total, label) may be None. cache is a dict the
                          caller keeps between calls of one session (incremental re-reads); sources may ignore it.
  live(lv)                -> live feed for live.Live `lv`: an object with build(now_ms) (first read of the session's
                          files, registering AgentStates in lv.agents and following files with lv.follow) and
                          discover(now_ms) (find files that appeared since).
  price_step(model, usage)  -> priced step {"cost", "tok", "priced", "local", "fast"} (see prices.py) from one model
                          response's usage, rated from the prices.json section named by id.
"""
import importlib
import re

BUILTIN = ("source_claude", "source_codex")  # adapter modules, in display order; each defines SOURCE
_REG = {}
_loaded = []


class Source:
    """Base class of a source adapter; see the module docstring for the contract."""
    id = ""
    label = ""
    color = "var(--c-other)"
    default = False
    dir_flag = ""
    dir_envs = ()
    dir_default = ""
    dir_help = ""
    ctx_limit_key = "ctxLimit"
    ctx_limit_default = 400000
    reparse_gap = 5.0
    page = {}

    @property
    def root(self):
        import config
        return config.source_dir(self.id)

    @property
    def dir_dest(self):
        return self.dir_flag.lstrip("-").replace("-", "_")

    def files(self):
        return ()

    def sniff(self, head):
        return False

    def scan(self, path):
        raise NotImplementedError

    def rows(self, recs, now_ms):
        raise NotImplementedError

    def tree(self, recs, root_id, path):
        return {root_id: path}

    def tree_for_path(self, path, root_id):
        import index
        recs, _ = index.build_index()
        r = index.find(recs, "%s:%s" % (self.id, root_id or ""))
        if r is None:
            r = next((x for x in recs.values() if x["path"] == path), None)
        if r is None:
            return root_id, {root_id: path}
        return r["id"], self.tree(recs, r["id"], r["path"])

    def session_files(self, recs, row):
        return list(self.tree(recs, row["id"], row["path"]).values())

    def parse(self, root_id, tree, name, out_chars, inp_chars, progress=None, cache=None):
        raise NotImplementedError

    def live(self, lv):
        raise NotImplementedError

    def price_step(self, model, usage):
        raise NotImplementedError

    def chip(self):
        """What the list page needs to show and filter this source."""
        return {"id": self.id, "label": self.label, "color": self.color}


def register(src):
    """Add (or replace) a source. Later registrations come later in all()."""
    _REG.pop(src.id, None)
    _REG[src.id] = src
    return src


def unregister(sid):
    _REG.pop(sid, None)


def _ensure():
    # Imported lazily: adapters import config / index, which themselves ask the registry at call time.
    if not _loaded:
        _loaded.append(True)
        for mod in BUILTIN:
            src = importlib.import_module(mod).SOURCE
            if src.id not in _REG:
                register(src)


def all():  # noqa: A001 - the registry's natural name
    _ensure()
    return list(_REG.values())


def ids():
    return [s.id for s in all()]


def get(sid):
    """The source registered as `sid`; KeyError for an unknown one."""
    _ensure()
    return _REG[sid]


def detect(path):
    """Source id of a file from its first bytes: the first source whose sniff() matches, else the default source."""
    try:
        with open(path, "rb") as f:
            head = f.read(300)
    except OSError:
        head = None
    srcs = all()
    if head is not None:
        for s in srcs:
            if not s.default and s.sniff(head):
                return s.id
    return next((s.id for s in srcs if s.default), srcs[0].id)


def route_pattern():
    """Regex alternation of the registered ids, for the server routes."""
    return "|".join(re.escape(i) for i in ids())
