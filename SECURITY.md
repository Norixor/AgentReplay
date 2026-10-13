# Security policy

AgentReplay is in pre-release development. Security fixes target the current
development line; no older release has a separate security-support commitment.
Test results and the smoke checks in `scripts/check.py` do not constitute a
security audit.

## What is sensitive here

AgentReplay reads the session transcripts that Claude Code and Codex write on
your machine. Those transcripts can contain secrets: API keys and tokens pasted
into prompts, credentials echoed by shell commands, file contents, customer
data and private paths. The pages the tool builds (and the `.html` files you
export with `-o`) embed that content. Redaction is rule-based and best effort.

## Report privately

On the project's GitHub repository, open **Security → Advisories → Report a
vulnerability**. Submit a private report containing the affected version or
commit, platform, reproduction steps and expected impact.

**Use synthetic data only.** The easiest way to reproduce an issue is
`agent-replay demo`, or a hand-written transcript with invented content. Do not
attach real session files, exported pages, passwords, API keys, authentication
headers or customer data, and redact paths and names that identify you.

If the private-report button is unavailable, open an issue containing only a
request for a private reporting channel. Do not include vulnerability details,
proof-of-concept code or sensitive attachments in that public issue.

## Maintainer handling

Before public launch, enable [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)
and verify the report entry point. This file alone does not enable it. Review
reports privately, reproduce them in an isolated environment with synthetic
data, coordinate the fix and disclosure with the reporter, and publish the
affected and fixed versions when a remediation is available. Do not promise a
response deadline that the maintenance team cannot support.

## In scope

- The local server being reachable from another host or origin: the `127.0.0.1`
  binding, the `Host` header check, DNS-rebinding style requests.
- Path handling that would let a request read or write files outside the
  session directories and `replays/`.
- Any write to session files, which the tool must treat as read-only.
- Redaction gaps where a common secret format reaches a page unmasked, and
  script injection through session content shown in a page.
- Network access of any kind: the tool is designed to make none.

Dependency reports are not applicable: the project uses only the Python
standard library and plain JavaScript.
