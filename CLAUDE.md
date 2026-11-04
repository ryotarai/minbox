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
