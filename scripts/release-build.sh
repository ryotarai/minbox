#!/usr/bin/env bash
# Cross-compiles minbox and packages one tarball per target plus checksums.txt.
#
#   scripts/release-build.sh [VERSION] [OUT_DIR]
#
# VERSION defaults to `git describe --tags --always --dirty` (as in the Makefile) and is stamped
# into internal/server.Version. OUT_DIR defaults to dist/release (gitignored).
# TARGETS overrides the os/arch list, e.g. TARGETS="darwin/arm64 linux/amd64".
#
# The web UI is embedded at build time, so web/dist must be built first (`make web`, or in CI
# `npm ci && npm run build` in web/). Every target is pure Go (CGO_ENABLED=0).
set -euo pipefail

cd "$(dirname "$0")/.."

version="${1:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
out="${2:-dist/release}"
targets="${TARGETS:-darwin/arm64 darwin/amd64 linux/arm64 linux/amd64}"
# Archive names carry the version without the leading "v": minbox_1.2.3_darwin_arm64.tar.gz.
fileversion="${version#v}"

if [ ! -f web/dist/index.html ]; then
  echo "web/dist/index.html is missing: build the web UI first (make web)" >&2
  exit 1
fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

rm -rf "$out"
mkdir -p "$out"
work="$(mktemp -d "${TMPDIR:-/tmp}/minbox-release.XXXXXX")"
trap 'rm -rf "$work"' EXIT

for target in $targets; do
  goos="${target%/*}"
  goarch="${target#*/}"
  name="minbox_${fileversion}_${goos}_${goarch}"
  dir="$work/$name"
  mkdir -p "$dir"
  echo "building $name"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath \
    -ldflags "-s -w -X github.com/ryotarai/minbox/internal/server.Version=${version}" \
    -o "$dir/minbox" ./cmd/minbox
  cp LICENSE README.md THIRD_PARTY_NOTICES.md "$dir/"
  tar -C "$work" -czf "$out/$name.tar.gz" "$name"
done

(cd "$out" && sha256 *.tar.gz > checksums.txt)
echo "wrote $out:"
ls -l "$out"
