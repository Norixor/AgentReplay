"""Session sources (Claude Code, Codex, ...): the registry and the contract every source adapter implements.

The rest of the tool never branches on a source name. Indexing, listing, the CLI, the data directory options, the server
routes, parsing, the live view, the step feed, pricing and the pages' source chip all go through the Source object
registered under the record's "tool" field. Adding a source = one adapter module that defines SOURCE (an instance of a
Source subclass) plus its module name in BUILTIN below.

Registry functions: all() (display order), ids(), get(id), register(src), unregister(id), detect(path), route_pattern().

Contract of a source adapter. Entries marked * must be provided; the others have defaults in Source.

Paths: the paths a source returns from files() and tree() are keys, not necessarily files on disk. A source whose
sessions share one store (e.g. one SQLite database) may return virtual paths such as "<db path>#<session id>"; only that
source's own stat / scan / parse / live (and session_files / tree) ever read them, every other module just passes them
along (index keys, cache signatures, step feed change detection all go through Source.stat). The CLI accepts a path
argument only for real files (sessions.resolve checks os.path.isfile and sniffs the file); sessions with virtual paths
are opened by session id prefix.

Attributes
  id *              stable key, [a-z0-9_]+. Used as the record / row "tool" field, the URL segment (/s/<id>/<session>,
                    /r/..., /api/open/..., /api/job/..., /api/live/..., /api/steps/...), the row key "<id>:<session id>",
                    cache file names, the prices.json section (and its sources.<id> link) and the CLI output file name
                    "<id>-<name>-<day>.html".
  label *           display name ("Claude Code"): list chip and filter option, loading page, replay page, CLI messages.
  color             CSS background of the source chip; any CSS colour, theme variables such as var(--opus-bg) work.
  default           True for exactly one source: the one assumed when no other source's sniff() recognises a file.
  dir_flag *        command line option for the data root, e.g. "--claude-dir" (argparse dest "claude_dir").
  dir_envs *        environment variables for the data root, first one set wins, e.g.
                    ("AGENT_REPLAY_CLAUDE_DIR", "CLAUDE_CONFIG_DIR"). The option beats them, they beat dir_default.
  dir_default *     default data root; "~" is expanded (e.g. os.path.join("~", ".claude")).
  dir_help *        help text of dir_flag.
  ctx_limit_key     live.json key of the context size above which the live view warns (default "ctxLimit"), and
  ctx_limit_default its default; live.py merges them into its defaults, so live.json may override the value.
  reparse_gap       minimum seconds between two background re-parses of one in-progress session (step feed), default 5.
  live_supported    default True. False: live() is never called and need not exist; /api/live/<id>/<session> answers
                    HTTP 409 {"ok": false, "code": "live_unsupported", "tool": id, "error": ...}; list rows and
                    /api/live-list keep showing active sessions with live = null; the replay page has no live tab
                    (meta.source.live = false) and makes no live requests. The step feed (/api/steps) does not use
                    live() and keeps working.
  page              replay-page hints, embedded with label, color and live as meta.source (render.py; replay.js):
                      fams   bool: colour models by the Claude family names (opus, sonnet, ...) instead of meta.models
                      notes  source-specific explanations, each optional (a missing note shows nothing):
                             why (where call reasons come from), mainSteps (what one main-agent step is), hooks (how hook
                             blocks are detected), hooksStop (suffix shown when totals.stopBlocks > 0, "{n}" = the count),
                             reasonMissing (shown when a brief has no model-choice reason line), lastText (how a sub-agent
                             report was taken when there is no handback call)

Methods
  root              property: the configured data root (config.source_dir(id)).
  files() *         -> iterable of file paths to index (sub-agent files too when the source indexes them as records of
                    their own, as Codex does).
  stat(path)        -> (size, mtime) of a path from files() / tree(); raises OSError when it is gone. size is an int,
                    mtime a float in seconds (compared for equality with index.json and hashed into page cache keys,
                    so it must be stable while the session is unchanged). Default os.stat (st_size, st_mtime).
  sniff(head)       -> bool: the first 300 bytes of a real file belong to this source (path arguments of the CLI).
  scan(path) *      -> index record: a JSON-serialisable dict cached in index.json (bump index.INDEX_VERSION when what a
                    source stores changes). Required keys: tool (= id), path, id, parent (parent record id or None;
                    records whose parent is another record of the same source are not offered on their own by the CLI),
                    archived (bool), cwd, start, end (ms or None), model, title0. Read only the head and tail of the
                    file (scan_util has helpers), never parse it whole.
  rows(recs, now_ms) *
                    -> list rows of the top-level sessions. recs: this source's records only, in index order, each with
                    size and mtime added. Build every row with scan_util.make_row() (it derives key, project, end and
                    the "active" / "archived" status) and fold sub-agent records or files into its subs, sub_size and
                    newest mtime.
  tree(recs, root_id, path)
                    -> {agent id: file path} of a listed session, root first: what parse() and the step feed read.
                    Default {root_id: path}.
  tree_for_path(path, root_id)
                    -> (root id, tree) when the caller has no index at hand (CLI export, render without a tree).
                    Default: look the session up in the index, else {root_id: path}.
  session_files(recs, row)
                    -> every file whose change must invalidate the cached page and the step feed. Default: the tree.
  parse(root_id, tree, name, out_chars, inp_chars, progress=None, cache=None) *
                    -> the page data model {"meta", "agents", "totals"} shared by every source (see parse.py,
                    parse_codex.py and common.totals; meta.tool = id, meta.pricing = prices.meta(id)).
                    progress(done, total, label) may be None. cache is a dict the caller keeps between calls for one
                    session (incremental re-reads of a growing session); a source may ignore it.
  live(lv)          (* when live_supported) -> live feed for live.Live lv: an object with build(now_ms) (first read: create AgentStates in
                    lv.agents, "main" first, and follow files with lv.follow(path, state, feed, now)) and
                    discover(now_ms) (start following files that appeared since). See live_claude.py, live_codex.py.
  price_step(model, usage) *
                    -> priced step {"cost", "tok", "priced", "local", "fast"} (prices.result) of one model response,
                    rated from prices.json[id]; parse() and the live feed price every step with it.
  chip(), page_meta()
                    what the list page and the replay page get about the source (built from the attributes).
"""
import importlib
import os
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
    live_supported = True
    page = {}

    @property
    def root(self):
        import config
        return config.source_dir(self.id)

    @property
    def dir_dest(self):
        return self.dir_flag.lstrip("-").replace("-", "_")

    def files(self):
        raise NotImplementedError

    def stat(self, path):
        st = os.stat(path)
        return st.st_size, st.st_mtime

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

    def page_meta(self):
        """meta.source of the replay page: label, chip colour and the page hints."""
        return dict(self.page, label=self.label, color=self.color, live=bool(self.live_supported))


def register(src):
    """Add (or replace) a source; it comes last in all()."""
    _REG.pop(src.id, None)
    _REG[src.id] = src
    return src


def unregister(sid):
    _REG.pop(sid, None)


def _ensure():
    # Imported lazily: the adapters import config, whose configure() itself asks the registry.
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
    """The source registered as sid; KeyError for an unknown one."""
    _ensure()
    return _REG[sid]


def detect(path):
    """Source id of a file from its first bytes: the first non-default source whose sniff() matches, else the default."""
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
