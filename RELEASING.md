# Release Checklist

Releases are built and published by `.github/workflows/release.yml`. Do not
publish from a workstation or move an existing release tag.

## Prepare the release

1. Create a release pull request from current `main`.
2. Move the relevant Unreleased entries in `CHANGELOG.md` under a dated
   `[<version>]` heading.
3. Run `npm version --no-git-tag-version <version>`, update `src/version.ts` to
   the same version, and review `package-lock.json`.
4. Run a clean `npm ci`, `just ci`, `just e2e`,
   `npm run release:check -- v<version> --skip-remote`, and
   `npm run package:smoke`.
5. Merge the approved pull request with a squash merge and wait for all four
   required CI checks on `main`.

## Publish

1. Synchronize local `main` and create an annotated SSH-signed tag:

   ```bash
   git tag -s v<version> -m "video-context-mcp v<version>"
   git push origin v<version>
   ```

2. Confirm the Release workflow verifies the tag, package metadata, package
   tarball, network E2E, and four-platform managed runtime matrix.
3. Review and approve the protected `npm` environment deployment.
4. Wait for npm publication, fresh-install verification, and GitHub release
   creation to complete.
5. Verify the npm package page shows public visibility and provenance, then run
   `npm install -g @smallthinkingmachines/video-context-mcp@<version>` from a
   clean temporary prefix.

## First-release bootstrap

The package must exist before npm Trusted Publishing can be configured. The
v0.8.0 workflow therefore uses the short-lived `NPM_BOOTSTRAP_TOKEN` environment
secret once. Immediately after v0.8.0 succeeds:

1. Configure npm Trusted Publishing for GitHub repository
   `smallthinkingmachines/video-context-mcp`, workflow `release.yml`, environment
   `npm`, with `npm publish` permission only.
2. Set package publishing access to require two-factor authentication and
   disallow tokens.
3. Delete the GitHub environment secret and revoke the npm bootstrap token.

Future releases use GitHub OIDC automatically. If a published release is bad,
deprecate it if necessary and publish a patch; never reuse a version or move its
tag.
