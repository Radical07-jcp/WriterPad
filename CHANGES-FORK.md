# Changes from upstream WordCraft 0.5.0

This is a modified, unofficial build, distributed under the MIT License (LICENSE-MIT).
Based on WordCraft by the ArtCraft team and community: https://github.com/storytold/wordcraft

- `crates/geom/src/lib.rs`: added paper size "Folio (8.5 x 13)" (612 x 936 pt) + tests.
- `crates/ui-egui/src/canvas.rs`: touch gestures (finger drag scrolls with coasting; rest then drag selects).
- `crates/ui-egui/src/lib.rs`: `touch_device` flag, 130% interface scale on touch screens (unless an Interface size is chosen); community button off by default.
- `crates/ui-egui/src/dialogs.rs`: About text states this is an unofficial modified build.
- `apps/wordcraft-web/*`: touch detection, PWA wrapper (manifest, service worker, icons).
- ArtCraft logos (`docs/brand/`) are not shipped. The ArtCraft name appears only as plain-text attribution.
- Removed (not used by the web build): desktop app, CLI, MCP server, control-key crate, xtask, docs/ (incl. the ArtCraft brand files, which a modified build must not ship), other platforms' CI and packaging, desktop icon sets, contributor/agent docs. NOTICE and ATTRIBUTION.md are kept; ATTRIBUTION.md lists only files still present. Upstream lives at the repository above.
