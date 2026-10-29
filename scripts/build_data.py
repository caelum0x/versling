#!/usr/bin/env python3
"""
Build Versling's verse dataset from verified, license-checked sources:

- Arabic text: official Tanzil.net direct download (Uthmani Minimal v1.0.2),
  License: Creative Commons Attribution 3.0. Fetched live from tanzil.net's
  own download endpoint with terms agreed, verbatim, unmodified.
- Transliteration: Tanzil Project transliteration edition, mirrored via the
  fawazahmed0/quran-api dataset (source field = tanzil.net), Unlicense
  (public-domain dedication) on the hosting/formatting layer.
- English translation: Mohammed Marmaduke Pickthall, "The Meaning of the
  Glorious Qur'an" (1930). Public domain (UK since 2007 per Pickthall's 1936
  death + life-70; US since 2026-01-01 per 95-years-from-publication rule for
  pre-1978 US works). Mirrored via fawazahmed0/quran-api (Unlicense).
- Surah metadata (name, meaning, revelation type, ayah count): factual,
  uncopyrightable bibliographic data, cross-checked against alquran.cloud's
  public meta endpoint.
- Per-surah one-line "context": original editorial text written for this
  product (scripts/surah_context.py), not copied from any translation or
  tafsir.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from surah_context import CONTEXT

ROOT = Path(__file__).parent.parent
TMP = Path("/tmp")
OUT = ROOT / "public" / "data"
OUT.mkdir(parents=True, exist_ok=True)

# ---- Parse official Tanzil Arabic download (pipe-delimited: sura|aya|text) ----
arabic = {}
with open(TMP / "tanzil_uthmani.txt", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        m = re.match(r"^(\d+)\|(\d+)\|(.+)$", line)
        if m:
            s, a, text = int(m.group(1)), int(m.group(2)), m.group(3)
            arabic[(s, a)] = text

assert len(arabic) == 6236, f"expected 6236 arabic verses, got {len(arabic)}"

# ---- Parse transliteration + Pickthall translation (fawazahmed0 mirrors) ----
def load_quran_json(path):
    d = json.load(open(path, encoding="utf-8"))["quran"]
    out = {}
    for item in d:
        out[(item["chapter"], item["verse"])] = item["text"]
    return out

translit = load_quran_json(TMP / "translit.json")
pickthall = load_quran_json(TMP / "pickthall.json")
assert len(translit) == 6236 and len(pickthall) == 6236

# ---- Surah metadata ----
meta = json.load(open(TMP / "meta.json", encoding="utf-8"))["data"]["surahs"]["references"]
assert len(meta) == 114

surahs_out = []
for s in meta:
    num = s["number"]
    surahs_out.append({
        "number": num,
        "nameArabic": s["name"],
        "nameEnglish": s["englishName"],
        "meaning": s["englishNameTranslation"],
        "revelationType": s["revelationType"],
        "ayahCount": s["numberOfAyahs"],
        "context": CONTEXT[num],
    })

(OUT / "surahs.json").write_text(json.dumps(surahs_out, ensure_ascii=False), encoding="utf-8")

# ---- Per-surah verse files ----
total_verses = 0
index = []
for s in surahs_out:
    num = s["number"]
    verses = []
    for a in range(1, s["ayahCount"] + 1):
        key = (num, a)
        verses.append({
            "surah": num,
            "ayah": a,
            "arabic": arabic[key],
            "transliteration": translit[key],
            "translation": pickthall[key],
        })
    total_verses += len(verses)
    (OUT / f"surah-{num}.json").write_text(json.dumps(verses, ensure_ascii=False), encoding="utf-8")
    index.append({"surah": num, "count": len(verses)})

(OUT / "index.json").write_text(json.dumps({
    "totalVerses": total_verses,
    "totalSurahs": len(surahs_out),
    "surahs": index,
}, ensure_ascii=False), encoding="utf-8")

print(f"OK: {total_verses} verses across {len(surahs_out)} surahs written to {OUT}")
