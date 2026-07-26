# Release Checklist

Releases are built and published by `.github/workflows/release.yml`. Do not
publish from a workstation or move an existing release tag.

## Prepare the release

1. Create a release pull request from current `main`.
2. Move the relevant Unreleased entries in `CHANGELOG.md` under a dated
   `[<version>]` heading.
3. Run `npm version --no-git-tag-version <version>`, update `src/version.ts` to
   the same version, and review `package-lock.json`.
4. Run a clean `npm ci`, `just ci`,
   `npm run release:check -- v<version> --skip-remote`, and
   `npm run package:smoke`. Run `just e2e` intentionally from a maintainer
   workstation when the release changes yt-dlp integration or the live provider
   boundary; it is not an automated release gate.
5. Merge the approved pull request with a squash merge and wait for all four
   required CI checks on `main`.

## Publish

1. Synchronize local `main` and create an annotated SSH-signed tag:

   ```bash
   git tag -s v<version> -m "video-context-mcp v<version>"
   git push origin v<version>
   ```

2. Confirm the Release workflow verifies the tag, package metadata, package
   tarball, deterministic provider fixtures, and four-platform managed runtime
   matrix without contacting YouTube.
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

## Resume an existing tag

If infrastructure prevents a tag-triggered run from reaching the protected npm
deployment, use the Release workflow's manual `release_tag` input. The workflow
checks out that exact tag and `release:check` rejects missing, lightweight,
unsigned, unverified, mismatched, or off-main tags before publication.

Because a manual run's Git ref is the default branch, temporarily add `main` to
the npm environment's selected deployment branches, approve only the expected
run, and remove that branch rule immediately afterward. The normal release path
remains restricted to `v*` tags.

## Live provider check

`just e2e` makes a real provider request and is deliberately local and opt-in.
Do not schedule it in GitHub Actions or make it a pull-request or release gate.
The deterministic fixture-backed integration test covers metadata, captions,
ingestion, transcript search, embedding repair, and cleanup on every CI run.
