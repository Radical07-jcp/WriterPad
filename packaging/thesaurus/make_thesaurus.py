#!/usr/bin/env python3
"""Trim the Moby Thesaurus II (public domain, Grady Ward) into assets/thesaurus/thesaurus.txt.

Usage: make_thesaurus.py mthesaur.txt assets/thesaurus/thesaurus.txt [max_related=25]
Keeps single-word roots and single-word related terms, at most `max_related` per root, so the
file stays a few MB (the full one is ~24 MB). Same line format: root,related,related,
"""
import sys

src, dst = sys.argv[1], sys.argv[2]
cap = int(sys.argv[3]) if len(sys.argv) > 3 else 25
out = []
with open(src, encoding="latin-1") as f:
    for line in f:
        parts = [p.strip() for p in line.strip().split(",") if p.strip()]
        if len(parts) < 2:
            continue
        root, rel = parts[0], parts[1:]
        if " " in root or not root.isalpha():
            continue
        rel = [r for r in rel if r.isalpha() and r.lower() != root.lower()][:cap]
        if rel:
            out.append(root.lower() + "," + ",".join(rel) + ",")
with open(dst, "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
print(f"{len(out)} roots written to {dst}")
