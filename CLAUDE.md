# CLAUDE.md

## npm dependencies: no versions younger than 72 hours

Never add or lock an npm package version that was published less than 72 hours ago. This
guards against supply-chain attacks, which are usually caught and unpublished within days.

- `web/.npmrc` sets `min-release-age=3` (days), so `npm install` / `npm update` in `web/`
  resolve only versions older than 3 days. Keep it there; do not override it with `--before`,
  `--min-release-age=0` or `min-release-age-exclude`.
- If a version you need is younger than 72 hours, wait. Do not pin it by hand in `package.json`
  or `package-lock.json`.
- `npm ci` installs exactly what the lockfile says and ignores the setting. After any change to
  `package-lock.json`, check that every version in it is older than 72 hours: read each
  version's publish date from `https://registry.npmjs.org/<name>` (`time[<version>]`).

## Releases and distribution

- Remotes (check with `git remote -v`): `origin` = private `ryotarai/minbox-private`, where
  development happens and agents push `main` after green gates. `public` = `ryotarai/minbox`,
  the public repo where releases live.
- Pushing a `v*` tag to the public repo runs `.github/workflows/release.yml`: builds `web/`,
  `go vet` / `go test`, cross-builds darwin/linux × arm64/amd64 with `scripts/release-build.sh`,
  and uploads `minbox_<version>_<os>_<arch>.tar.gz` + `checksums.txt` with `--generate-notes`.
  Tags containing `-` (`v1.2.0-rc.1`) become prereleases. The version is stamped from the tag via
  `-X github.com/ryotarai/minbox/internal/server.Version=`.
- The person syncs private → public and creates and pushes tags. Agents do not push to the
  `public` remote, create or push tags, or create GitHub releases unless the person explicitly
  asks for that specific action. (Public sync has been a force-push of `main` keeping a backup
  branch, and only when asked.)
- minbox ships as a single binary. The web UI and the agent plugins (`plugin/minbox` Claude Code
  mod, Pi extension, OpenCode plugin) are embedded with `go:embed` and extracted at startup into
  the data dir under a content-hash directory (0700/0600); old versions are cleaned up. Agents
  load them via `claude --plugin-dir`, `pi -e` and `OPENCODE_CONFIG_CONTENT`. Installing minbox
  is one binary: never add a step that installs plugins separately.
- For development, `MINBOX_PLUGIN_SOURCE=$PWD/plugin` makes minbox use the checkout's `plugin/`
  directly. Do not leave it set when running e2e.
- macOS binaries are not signed or notarized yet.
