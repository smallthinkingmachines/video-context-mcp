# Security Policy

## Supported versions

Before the first npm release, security fixes are made on `main`. After
publication, only the latest released minor version and `main` receive security
updates.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use this
repository's **Security → Report a vulnerability** flow to submit a private
GitHub Security Advisory.

Include the affected version or commit, operating system, reproduction steps,
impact, and any suggested mitigation. Remove credentials, cookies, private
video URLs, transcript content, and local filesystem details that are not
needed to reproduce the issue.

The maintainers will assess the report privately and coordinate disclosure and
a fix when warranted. For ordinary bugs without sensitive information, use the
bug-report issue form.

## Audited transitive exception

The v0.8.0 production audit has no high or critical findings. It allowlists
only [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9),
a moderate path-traversal advisory in the Hono `serve-static` adapter pulled in
by the MCP SDK. This project does not import that adapter, serve static files,
or expose an HTTP server; it uses the SDK's stdio transport. Release smoke tests
reject every other production advisory, and this exception should be removed
when the SDK accepts the patched Hono adapter line.

## Trust boundary

This project is designed as a local stdio MCP server for clients you control.
Its MCP client can request reads of local video paths, and derived data is kept
as ordinary files and a local database under `VCM_CACHE_DIR`. Do not expose the
server to untrusted clients or over a network without an authorization layer.
