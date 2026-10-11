# Fonts in WriterPad

## Microsoft fonts are NOT included
Calibri, Cambria, Arial, Times New Roman, Courier New, Segoe UI and the other Microsoft fonts are
proprietary: owned by Microsoft or its font suppliers (for example Monotype) and licensed with Windows
and Microsoft 365. Their licences do not allow this project, or a website, to hand copies to visitors,
and that is true for personal, non-commercial sites too, because a public site serves the files to
everyone who opens it. No licence text can be "attached" to grant that permission; only Microsoft can.
See https://learn.microsoft.com/en-us/typography/ and the licence that came with your copy of Windows/Office.

## What is bundled instead (SIL Open Font License 1.1)
| Your document says | WriterPad shows | Same character widths |
|---|---|---|
| Calibri | Carlito | yes |
| Cambria | Caladea | yes |
| Arial | Liberation Sans | yes |
| Times New Roman | Liberation Serif | yes |
| Courier New | Liberation Mono | yes |

Also bundled: Inter, Source Sans 3, Source Serif 4, JetBrains Mono, Poppins, Lora. Licence texts:
`/licenses/OFL-*.txt`; authors and sources: `ATTRIBUTION.md`.

## Using your own copy of a Microsoft font (personal use)
File > Open, then pick a `.ttf` / `.otf` font file. WriterPad installs it into **your browser only**
(IndexedDB, never uploaded or published) and loads it on every start. Reopen any document that uses it.
You are responsible for having the right to use that font file on that device; check the terms of your
Windows/Microsoft 365 licence.
