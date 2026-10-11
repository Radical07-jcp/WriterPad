#!/usr/bin/env bash
# Build the installable WordCraft web app into dist/web, with all licence notices included.
# Needs: rust (>= 1.90) + wasm32-unknown-unknown, trunk, cargo-about.
#   rustup target add wasm32-unknown-unknown && cargo install trunk cargo-about --locked
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

(cd apps/wordcraft-web && trunk build --release)
SITE="$ROOT/dist/web"
[ -f "$SITE/index.html" ] || { echo "error: build produced no index.html" >&2; exit 1; }
if grep -Eq '(src|href)="/[^/]' "$SITE/index.html"; then
  echo "error: root-absolute URLs in index.html; would break under a sub-path" >&2; exit 1
fi

L="$SITE/licenses"; mkdir -p "$L"
cp LICENSE-MIT "$L/LICENSE-MIT.txt"
cp LICENSE-APACHE "$L/LICENSE-APACHE.txt"
cp NOTICE "$L/NOTICE.txt"
cp ATTRIBUTION.md "$L/ATTRIBUTION.md.txt"
cp assets/fonts/OFL-*.txt "$L/"
cp packaging/web-pwa/licenses-index.html "$L/index.html"
cargo about generate --config packaging/web-pwa/about.toml \
  --manifest-path apps/wordcraft-web/Cargo.toml \
  packaging/web-pwa/about.hbs > "$L/third-party-rust.html"

cp packaging/web/_headers "$SITE/_headers"
cp packaging/web/.htaccess "$SITE/.htaccess"
# The ArtCraft brand files (docs/brand) are deliberately NOT shipped.
for f in index.html manifest.webmanifest sw.js icon-180.png licenses/index.html licenses/third-party-rust.html; do
  [ -s "$SITE/$f" ] || { echo "error: missing $f in $SITE" >&2; exit 1; }
done
echo "OK: $SITE"; du -sh "$SITE"
