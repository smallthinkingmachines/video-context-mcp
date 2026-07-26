## Summary

Describe the user-visible outcome and why the change is needed.

## Verification

- [ ] `just ci` passes
- [ ] `just e2e` was intentionally run from a maintainer workstation, or the change does not affect the live provider boundary
- [ ] Public tool schemas and README examples are updated where applicable
- [ ] New user-facing failures use `VcmError`/`toToolError` with actionable text
- [ ] Server logs remain on stderr; stdout remains reserved for MCP
- [ ] Third-party licenses/notices are updated if dependencies or managed artifacts changed
