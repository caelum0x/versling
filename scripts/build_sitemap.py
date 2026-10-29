#!/usr/bin/env python3
"""Generate public/sitemap.xml listing the homepage plus a real deep-link URL
for every one of the 6,236 verses (?v=surah:ayah), so search engines have a
way to discover individual verses at all.

Why this exists: Versling already builds and serves real per-verse URLs
(public/app.js verseUrl/updateUrlForGi) and the worker (src/worker.js)
server-renders real per-verse <title>/meta tags and verse content for those
URLs — but with no sitemap, search engines have no way to ever find any of
those 6,236 individual URLs to crawl them in the first place. Re-run this
whenever surah/verse data changes.
"""
import json
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE, "public", "data")
OUT_PATH = os.path.join(BASE, "public", "sitemap.xml")
SITE = "https://versling.subasiarhan3.workers.dev"
LASTMOD = "2026-10-29"


def main():
    with open(os.path.join(DATA_DIR, "surahs.json"), "r", encoding="utf-8") as f:
        surahs = json.load(f)

    urls = [f"{SITE}/"]
    for s in surahs:
        num = s["number"]
        for ayah in range(1, s["ayahCount"] + 1):
            urls.append(f"{SITE}/?v={num}:{ayah}")

    lines = ['<?xml version="1.0" encoding="UTF-8"?>']
    lines.append('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    for u in urls:
        lines.append("  <url>")
        lines.append(f"    <loc>{u}</loc>")
        lines.append(f"    <lastmod>{LASTMOD}</lastmod>")
        lines.append("  </url>")
    lines.append("</urlset>")

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(f"Wrote {len(urls)} URLs to {OUT_PATH}")


if __name__ == "__main__":
    main()
