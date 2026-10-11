# WordCraft for iPad (web build)

Unofficial modified build of [WordCraft](https://github.com/storytold/wordcraft) (MIT OR Apache-2.0; this build is distributed under MIT). The upstream README, docs, desktop/CLI/MCP apps and other-platform packaging were removed because the web build does not use them.

Changes are listed in `CHANGES-FORK.md`. Added for this build: `apps/wordcraft-web/pwa/*` (manifest, offline service worker, icons), a PWA-ready `apps/wordcraft-web/index.html`, `packaging/web-pwa/*` (build script and licence bundling) and `.github/workflows/pages.yml`.

## Deploy (GitHub Pages, free, HTTPS)
1. Create a GitHub repo and push this folder to its `main` branch.
2. Repo **Settings > Pages > Source: GitHub Actions**.
3. The *Deploy web app* workflow builds and publishes. Your URL: `https://<user>.github.io/<repo>/`.

Other hosts: run `packaging/web-pwa/build.sh` and upload `dist/web/` (Cloudflare Pages and Netlify
read the included `_headers`). HTTPS is required for WebGPU, the offline cache and install.

## Install on the iPad
Open the URL in Safari > Share > **Add to Home Screen**. It then runs full-screen and works
offline after the first load (~13 MB download, ~5 MB compressed). Open files with the in-app Open
dialog; Save/Export downloads to the Files app.

## Licence compliance (what this build does)
- Ships `LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE`, `ATTRIBUTION.md`, the four OFL font licences and
  a generated list of every Rust crate's licence under `/licenses/` (linked from `index.html`).
- Does **not** ship `docs/brand/*`. ArtCraft's name/logo are trademarks (`docs/brand/LICENSE-brand.txt`):
  if you modify the Rust UI, remove ArtCraft marks from it, don't call it ArtCraft, and say only in
  plain text that it is based on WordCraft by the ArtCraft team.
- Keep the copyright notice and NOTICE if you redistribute.

## iPad touch controls
Tap = caret. Double/triple tap = select word/paragraph. Drag = scroll (with coasting). Rest a finger
~0.5 s, then drag = select text. Pinch = zoom the page. The interface is drawn 30% larger on touch
screens unless you set File > Options > Interface size. Paper: Layout > Size > Folio (8.5 x 13).

## Adding fonts
Drop `.ttf` / `.otf` files, a whole font folder, or a font `.zip` (e.g. a Google Fonts download, which already includes its `OFL.txt`) into `assets/fonts/`, commit and push. Subfolders are fine; if a folder has a variable font, its `static/` copy is skipped. Keep each family's licence text with it. The build embeds every font file in that folder
automatically; the family name inside the file is what appears in the font list. Each font adds to the
app's download size. Only add fonts whose licence lets you redistribute them (OFL, Apache, public domain):
a public repo and site hand the files to everyone, so Microsoft fonts do not belong there
(see `FONTS-NOTICE.md`).
