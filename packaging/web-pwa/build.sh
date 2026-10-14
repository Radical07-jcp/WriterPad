#!/usr/bin/env bash
# Build the installable WordCraft web app into dist/web, with all licence notices included.
# Needs: rust (>= 1.90) + wasm32-unknown-unknown, trunk, cargo-about.
#   rustup target add wasm32-unknown-unknown && cargo install trunk cargo-about --locked
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# A font pack dropped in as a .zip (for example a Google Fonts download) is unpacked into a folder of the same name.
find assets/fonts -type f -iname '*.zip' | while read -r z; do unzip -oq "$z" -d "${z%.*}"; done

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
cp FONTS-NOTICE.md "$L/FONTS-NOTICE.txt"
cp apps/wordcraft-web/pdf/vendor/LICENSE-pdfjs.txt "$L/PDFJS-LICENSE-Apache-2.0.txt"
cp apps/wordcraft-web/pdf/vendor/LICENSE-pdf-lib.txt "$L/PDF-LIB-LICENSE-MIT.txt"
# Licence texts anywhere under assets/fonts (copied flat, folder names kept in the file name) and the font list.
mkdir -p "$L/fonts"
find assets/fonts -type f \( -iname '*.txt' -o -iname 'LICENSE*' -o -iname 'LICENCE*' -o -iname 'OFL*' \) | while read -r f; do
  rel="${f#assets/fonts/}"; cp "$f" "$L/fonts/${rel//\//__}"
done
find assets/fonts -type f \( -iname '*.ttf' -o -iname '*.otf' -o -iname '*.ttc' -o -iname '*.otc' \) | sed 's#^assets/fonts/##' | sort > "$L/FONT-FILES.txt"
echo "Bundled font files: $(wc -l < "$L/FONT-FILES.txt")"
cp packaging/web-pwa/licenses-index.html "$L/index.html"
cargo about generate --config packaging/web-pwa/about.toml \
  --manifest-path apps/wordcraft-web/Cargo.toml \
  packaging/web-pwa/about.hbs > "$L/third-party-rust.html"

cp packaging/web/_headers "$SITE/_headers"
cp packaging/web/.htaccess "$SITE/.htaccess"
# The ArtCraft brand files (docs/brand) are deliberately NOT shipped.
for f in index.html pdf/index.html pdf/app.js pdf/vendor/pdf.min.mjs pdf/vendor/pdf.worker.min.mjs pdf/vendor/pdf-lib.min.js manifest.webmanifest sw.js icon-180.png licenses/index.html licenses/third-party-rust.html; do
  [ -s "$SITE/$f" ] || { echo "error: missing $f in $SITE" >&2; exit 1; }
done
echo "OK: $SITE"; du -sh "$SITE"
