# Lays out Jot exports with attachments the way Jot's ExportFile.materialize
# does (<stem>/<stem>.md and <stem>/media/<id>.<ext>), for zip-folder.swift
# to zip as Jot does. The jots use ExportBuilder's attachment links. Remade
# the zips in this folder with:
#   python3 make-exports.py out
#   for d in out/*/; do swift zip-folder.swift "$d" "$(basename "$d").zip"; done
import os, sys, zlib, struct, shutil
NNBSP = "\u202f"
def t(s): return s.replace(" AM", NNBSP + "AM").replace(" PM", NNBSP + "PM")

def png(w, h, seed):
    rows = b""
    for y in range(h):
        rows += b"\x00" + bytes(((x * 4 + seed) % 256, (y * 5 + seed * 3) % 256, (x * y + seed) % 256) [i % 3] for x in range(w) for i in range(3))
    def chunk(kind, data):
        c = struct.pack(">I", len(data)) + kind + data
        return c + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")

PHOTO = "3F2A9C41-6B7D-4E8F-9A0B-1C2D3E4F5A6B"
DRAWING = "8E7D6C5B-4A39-4281-B7C6-D5E4F3A2B1C0"
FILE = "5D4C3B2A-1908-4F7E-A6D5-C4B3A2918070"
VIDEO = "A1B2C3D4-E5F6-4789-8ABC-DEF012345678"
IDS = {"Places": "A83D5E21-7B6C-4D9E-9F01-2C3D4E5F6A7B", "Gifts": "C47E9A10-2F3B-4C5D-8E6F-7A8B9C0D1E2F", "Ideas": "6F1C2B9A-3D4E-4F5A-8B7C-1A2B3C4D5E6F"}

def block(name, lines):
    return f'<!-- jot:category name="{name}" id="{IDS[name]}" -->\n' + "\n\n".join(t(l) for l in lines) + "\n<!-- /jot:category -->"

def export(date, stats, blocks):
    return f"<!-- jot:export v=1 date={date} -->\n{stats}\n\n" + "\n\n\n".join(blocks)

def write(stem, text, media):
    root = os.path.join(sys.argv[1], stem)
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(os.path.join(root, "media"))
    open(os.path.join(root, stem + ".md"), "w", encoding="utf-8").write(text)
    for name, data in media.items():
        open(os.path.join(root, "media", name), "wb").write(data)

# 1. All categories, attachments pinned first (Jot's default), newest first.
text1 = export("2026-10-28T19:40:12Z", "Stats: 5 jots across 2 categories", [
    block("Places", [
        f"- 10/28/26, 12:30 PM Café Lisboa on 5th, try the pastéis de nata ![{PHOTO}.png](media/{PHOTO}.png)",
        f"- 10/26/26, 9:05 AM Trail map for the ridge walk ![{DRAWING}.png](media/{DRAWING}.png)",
        "- 10/25/26, 4:10 PM Botanical garden greenhouse, open late Fridays",
    ]),
    block("Gifts", [
        f"- 10/27/26, 8:05 PM Packing list for the cabin gift basket [file: media/{FILE}.pdf] [video: media/{VIDEO}.mov]",
        "- 10/24/26, 1:20 PM Pottery class voucher",
    ]),
])
pdf = b"%PDF-1.4\n% Jot Import test file\n" + b"1 0 obj << /Type /Catalog >> endobj\n" * 40 + b"%%EOF\n"
mov = bytes((i * 7919) % 251 for i in range(3000))
write("jot-export-2026-10-28-1540", text1, {f"{PHOTO}.png": png(48, 32, 7), f"{DRAWING}.png": png(24, 24, 99), f"{FILE}.pdf": pdf, f"{VIDEO}.mov": mov})

# 2. One category scoped (its name is in the file name), non-ASCII.
PHOTO2 = "0C1D2E3F-4A5B-4C6D-8E7F-901A2B3C4D5E"
text2 = export("2026-10-29T14:10:00Z", "Stats: 1 jot across 1 category", [
    block("Ideas", [f"- 10/29/26, 9:10 AM A reading nook under the stairs ![{PHOTO2}.png](media/{PHOTO2}.png)"]),
])
write("jot-export-Idées-2026-10-29-0910", text2, {f"{PHOTO2}.png": png(16, 16, 3)})
