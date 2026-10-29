"""Generate synthetic PS2 memory card fixtures with mymc++.

Every save here is fake (handmade icon.sys, a tiny 3D icon, seeded random
data), so the output is safe to commit to a public repo.

For each card we write:
  <name>.ps2   the card image
  <name>.json  what mymc++ sees on it (the "golden" answer the tests compare to)

Run through scripts/make-fixtures.sh, which sets up the Python environment.
"""

import gzip
import hashlib
import io
import json
import math
import random
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

from mymcplusplus import ps2mc, ps2mc_dir

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "fixtures"
MYMC = [sys.executable, "-m", "mymcplusplus"]

CLUSTERS = {8: 8192, 16: 16384, 32: 32768, 64: 65536}


# ---------------------------------------------------------------- icon.sys

def make_icon_sys(title: str, line_break_chars: int, normal: str, copy: str, delete: str) -> bytes:
    """Build a 964-byte icon.sys. `title` is encoded as Shift-JIS."""
    raw_title = title.encode("shift_jis")
    # The line break offset is in bytes, so convert from characters.
    break_offset = len(title[:line_break_chars].encode("shift_jis"))
    bg = [
        (64, 0, 96, 0), (0, 64, 96, 0),      # top-left, top-right
        (16, 16, 32, 0), (32, 16, 16, 0),    # bottom-left, bottom-right
    ]
    light_dirs = [(0.5, 0.5, 0.5, 0.0), (0.0, -0.4, -0.1, 0.0), (-0.5, -0.5, 0.5, 0.0)]
    light_colors = [(0.3, 0.3, 0.3, 0.0), (0.4, 0.4, 0.4, 0.0), (0.5, 0.5, 0.5, 0.0)]
    ambient = (0.2, 0.2, 0.2, 0.0)

    out = io.BytesIO()
    out.write(b"PS2D")
    out.write(struct.pack("<HHII", 0, break_offset, 0, 0))  # background transparency = 0
    for c in bg:
        out.write(struct.pack("<4I", *c))
    for d in light_dirs:
        out.write(struct.pack("<4f", *d))
    for c in light_colors:
        out.write(struct.pack("<4f", *c))
    out.write(struct.pack("<4f", *ambient))
    out.write(raw_title.ljust(68, b"\0"))
    for name in (normal, copy, delete):
        out.write(name.encode("ascii").ljust(64, b"\0"))
    out.write(b"\0" * 512)
    data = out.getvalue()
    assert len(data) == 964, len(data)
    return data


# ---------------------------------------------------------------- .ico

def _pyramid(scale: float):
    """Triangles of a square pyramid, as (x, y, z) tuples."""
    top = (0.0, -1.0 * scale, 0.0)
    base = [(-0.7, 0.6, -0.7), (0.7, 0.6, -0.7), (0.7, 0.6, 0.7), (-0.7, 0.6, 0.7)]
    tris = []
    for i in range(4):
        tris += [top, base[i], base[(i + 1) % 4]]
    tris += [base[0], base[2], base[1], base[0], base[3], base[2]]
    return tris


def _texture(rng: random.Random) -> bytes:
    """128x128 RGB5A1 checkerboard in two random colors."""
    c1 = rng.randrange(0x8000) | 0x8000
    c2 = rng.randrange(0x8000) | 0x8000
    px = bytearray()
    for y in range(128):
        for x in range(128):
            px += struct.pack("<H", c1 if ((x // 16) + (y // 16)) % 2 else c2)
    return bytes(px)


def _rle(tex: bytes) -> bytes:
    """Compress a texture with the PS2 icon RLE (repeat runs only)."""
    words = [tex[i:i + 2] for i in range(0, len(tex), 2)]
    out = bytearray()
    i = 0
    while i < len(words):
        run = 1
        while i + run < len(words) and words[i + run] == words[i] and run < 0x7FFF:
            run += 1
        out += struct.pack("<H", run) + words[i]
        i += run
    return bytes(out)


def make_ico(rng: random.Random, compressed: bool) -> bytes:
    """A two-shape animated pyramid with a texture.

    Frame key counts are written as (keys + 1), which is how mymc++ reads them.
    TODO(phase 2): confirm against ps2mc-browser; other docs store the plain count.
    """
    shapes = [_pyramid(1.0), _pyramid(1.6)]
    n = len(shapes[0])
    tex_type = 0x07 | (0x08 if compressed else 0)
    out = io.BytesIO()
    out.write(struct.pack("<IIIfI", 0x010000, len(shapes), tex_type, 1.0, n))
    for v in range(n):
        for s in shapes:
            x, y, z = s[v]
            out.write(struct.pack("<hhhH", round(x * 4096), round(y * 4096), round(z * 4096), 0))
        nx, ny, nz = shapes[0][v]
        length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        u = (v % 3) * 2048
        w = (v % 2) * 4096
        out.write(struct.pack("<hhhHhhBBBB",
                              round(nx / length * 4096), round(ny / length * 4096),
                              round(nz / length * 4096), 0, u, w, 128, 128, 128, 128))
    # Animation: header, then one frame per shape with two keys each.
    out.write(struct.pack("<IIfII", 0x01, 60, 1.0, 0, len(shapes)))
    for shape_id in range(len(shapes)):
        keys = [(0.0, 1.0 if shape_id == 0 else 0.0), (30.0, 0.0 if shape_id == 0 else 1.0)]
        out.write(struct.pack("<IIII", shape_id, len(keys) + 1, 0, 0))
        for t, val in keys:
            out.write(struct.pack("<ff", t, val))
    tex = _texture(rng)
    if compressed:
        packed = _rle(tex)
        out.write(struct.pack("<I", len(packed)) + packed)
    else:
        out.write(tex)
    return out.getvalue()


# ---------------------------------------------------------------- saves

def write_save(base: Path, name: str, files: dict[str, bytes]) -> Path:
    d = base / name
    d.mkdir(parents=True)
    for fname, data in files.items():
        (d / fname).write_bytes(data)
    return d


def build_saves(tmp: Path) -> dict[str, Path]:
    rng = random.Random(1234)
    saves = {}

    saves["simple"] = write_save(tmp, "BASLUS-00001SYNTH", {
        "icon.sys": make_icon_sys("Synthetic SaveSlot 1", 14, "icon.ico", "icon.ico", "icon.ico"),
        "icon.ico": make_ico(rng, compressed=False),
        "BASLUS-00001SYNTH": rng.randbytes(5000),
    })

    # Full-width title, as many Japanese and Western games use.
    jp_title = "ＪＰ　テスト　セーブ" + "データ　１"
    saves["japanese"] = write_save(tmp, "BISLPS-00002JPTEST", {
        "icon.sys": make_icon_sys(jp_title, 10, "jp.ico", "jp.ico", "jp.ico"),
        "jp.ico": make_ico(rng, compressed=True),
        "data0": rng.randbytes(1024),          # exactly one cluster
        "data1": b"",                          # empty file
    })

    saves["icons"] = write_save(tmp, "BASLES-00003ICONS", {
        "icon.sys": make_icon_sys("Three IconsSave", 11, "list.ico", "copy.ico", "del.ico"),
        "list.ico": make_ico(rng, compressed=False),
        "copy.ico": make_ico(rng, compressed=True),
        "del.ico": make_ico(rng, compressed=False),
        "SAVE.DAT": rng.randbytes(20000),
    })

    saves["big"] = write_save(tmp, "BASLUS-00005BIGDATA", {
        "icon.sys": make_icon_sys("Big Save", 4, "icon.ico", "icon.ico", "icon.ico"),
        "icon.ico": make_ico(rng, compressed=True),
        "big.bin": rng.randbytes(300_000),
    })

    saves["small_a"] = write_save(tmp, "BASLUS-00006SMALLA", {
        "icon.sys": make_icon_sys("Small A", 6, "icon.ico", "icon.ico", "icon.ico"),
        "icon.ico": make_ico(rng, compressed=True),
        "a.bin": rng.randbytes(3000),
    })

    saves["small_c"] = write_save(tmp, "BASLUS-00007SMALLC", {
        "icon.sys": make_icon_sys("Small C", 6, "icon.ico", "icon.ico", "icon.ico"),
        "icon.ico": make_ico(rng, compressed=True),
        "c.bin": rng.randbytes(3000),
    })

    saves["grower"] = write_save(tmp, "BASLUS-00008GROWER", {
        "icon.sys": make_icon_sys("Fragmented", 10, "icon.ico", "icon.ico", "icon.ico"),
        "icon.ico": make_ico(rng, compressed=True),
        "g.bin": rng.randbytes(40_000),
    })

    # PS1 save stored on a PS2 card: no icon.sys, PSX flag set later.
    saves["ps1"] = write_save(tmp, "BESLES-00004PS1", {
        "BESLES-00004PS1": rng.randbytes(8192),
    })

    saves["hidden"] = write_save(tmp, "BASLUS-00009HIDDEN", {
        "icon.sys": make_icon_sys("Hidden Save", 6, "icon.ico", "icon.ico", "icon.ico"),
        "icon.ico": make_ico(rng, compressed=True),
        "h.bin": rng.randbytes(100),
    })

    loose = tmp / "loose"
    loose.mkdir()
    (loose / "ROOTFILE.BIN").write_bytes(rng.randbytes(2048))
    saves["loose_file"] = loose / "ROOTFILE.BIN"
    return saves


# ---------------------------------------------------------------- mymc++ helpers

def mymc(card: Path, *args: str) -> str:
    res = subprocess.run([*MYMC, str(card), *args], capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"mymc++ {' '.join(args)} failed:\n{res.stdout}{res.stderr}")
    return res.stdout


def fmt(card: Path, size_mb: int = 8, ecc: bool = True) -> None:
    card.unlink(missing_ok=True)
    args = ["format", "-c", str(CLUSTERS[size_mb])]
    if not ecc:
        args.append("-e")
    mymc(card, *args)


def add_save(card: Path, save_dir: Path) -> None:
    name = save_dir.name
    mymc(card, "mkdir", name)
    files = sorted(save_dir.iterdir(), key=lambda p: (p.name != "icon.sys", p.name))
    mymc(card, "add", "-d", name, *[str(f) for f in files])


def check(card: Path) -> None:
    out = mymc(card, "check")
    if "No errors found" not in out:
        raise RuntimeError(f"{card.name}: mymc++ check failed:\n{out}")


# ---------------------------------------------------------------- golden output

def describe(card: Path) -> dict:
    """Everything the tests compare against, read through the mymc++ library."""
    with open(card, "rb") as f:
        mc = ps2mc.ps2mc(f)
        has_ecc = mc.spare_size != 0
        sb = {
            "page_len": mc.page_size,
            "pages_per_cluster": mc.pages_per_cluster,
            "pages_per_erase_block": mc.pages_per_erase_block,
            "clusters_per_card": mc.clusters_per_card,
            "alloc_offset": mc.allocatable_cluster_offset,
            "alloc_end": mc.allocatable_cluster_end,
            "rootdir_cluster": mc.rootdir_fat_cluster,
            "backup_block1": mc.good_block1,
            "backup_block2": mc.good_block2,
            "ifc_list": [c for c in mc.indirect_fat_cluster_list if c != 0],
        }

        def entry(ent) -> dict:
            mode, _, length, created, cluster, parent, modified, attr, name = ent
            return {
                "name": name.split(b"\0", 1)[0].decode("ascii"),
                "mode": mode,
                "length": length,
                "created": list(created),
                "modified": list(modified),
                "cluster": cluster,
                "attr": attr,
            }

        def chain_ranges(first: int) -> list[list[int]]:
            """The file's cluster chain as [start, count] runs of consecutive clusters."""
            runs: list[list[int]] = []
            c = first
            for _ in range(mc.clusters_per_card):
                if runs and runs[-1][0] + runs[-1][1] == c:
                    runs[-1][1] += 1
                else:
                    runs.append([c, 1])
                nxt = mc.lookup_fat(c)
                if nxt == ps2mc.PS2MC_FAT_CHAIN_END:
                    return runs
                assert nxt & ps2mc.PS2MC_FAT_ALLOCATED_BIT, "chain points at a free cluster"
                c = nxt & ~ps2mc.PS2MC_FAT_ALLOCATED_BIT
            raise AssertionError("FAT chain loop")

        def walk(path: str, depth: int = 0) -> list[dict]:
            d = mc.dir_open(path)
            try:
                ents = list(d)
            finally:
                d.close()
            result = []
            for raw in ents:
                e = entry(raw)
                if not (e["mode"] & ps2mc_dir.DF_EXISTS) or e["name"] in (".", ".."):
                    continue
                child = path.rstrip("/") + "/" + e["name"]
                if ps2mc_dir.mode_is_dir(e["mode"]):
                    e["children"] = walk(child, depth + 1)
                else:
                    fh = mc.open(child, "rb")
                    data = fh.read()
                    fh.close()
                    assert len(data) == e["length"]
                    e["sha256"] = hashlib.sha256(data).hexdigest()
                if e["length"] > 0 or not ps2mc_dir.mode_is_file(e["mode"]):
                    e["chain"] = chain_ranges(e["cluster"])
                result.append(e)
            return result

        info = {
            "file_size": card.stat().st_size,
            "has_ecc": has_ecc,
            "superblock": sb,
            "free_bytes": mc.get_free_space(),
            "root": walk("/"),
        }
        mc.close()
    try:
        info["mymc_dir"] = mymc(card, "dir")
    except RuntimeError:
        # mymc++ 3.2.0 crashes listing cards with PS1 saves; the structured data above still holds.
        info["mymc_dir"] = None
    info["mymc_df"] = mymc(card, "df")
    return info


def finish(card: Path) -> None:
    """Check the card, write its golden JSON, and store it gzipped (cards are mostly empty)."""
    check(card)
    card.with_suffix(".json").write_text(json.dumps(describe(card), indent=2, ensure_ascii=False) + "\n")
    gz = card.with_name(card.name + ".gz")
    # mtime=0 keeps the .gz identical when the card bytes are identical.
    with open(card, "rb") as src, gzip.GzipFile(gz, "wb", mtime=0) as dst:
        shutil.copyfileobj(src, dst)
    print(f"  {gz.name}")


# ---------------------------------------------------------------- cards

def fill_card(card: Path, tmp: Path, rng: random.Random) -> None:
    """Add data until there's no room left for even one more cluster."""
    mymc(card, "mkdir", "BASLUS-00010FILLER")
    part = 0
    while True:
        with open(card, "rb") as f:
            mc = ps2mc.ps2mc(f)
            free = mc.get_free_space()
            mc.close()
        if free < 1024:
            return
        added = False
        # A new file may also need a new directory cluster, so try a bit smaller each time.
        for spare in range(0, 4):
            size = free - spare * 1024
            if size <= 0:
                break
            f = tmp / f"fill{part}.bin"
            # Repetitive (compressible) data keeps the gzipped fixture small.
            f.write_bytes((f"FILL{part:04d}".encode() * (size // 8 + 1))[:size])
            try:
                mymc(card, "add", "-d", "BASLUS-00010FILLER", str(f))
                added = True
                part += 1
                break
            except RuntimeError:
                mymc(card, "remove", f"BASLUS-00010FILLER/{f.name}") if _exists(card, f"BASLUS-00010FILLER/{f.name}") else None
        if not added:
            return


def _exists(card: Path, path: str) -> bool:
    with open(card, "rb") as f:
        mc = ps2mc.ps2mc(f)
        mode = mc.get_mode(path)
        mc.close()
    return mode is not None


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        s = build_saves(tmp / "saves")
        rng = random.Random(99)
        print("Writing fixtures to", OUT.relative_to(ROOT))

        card = OUT / "empty-8mb.ps2"
        fmt(card)
        finish(card)

        card = OUT / "one-save-8mb.ps2"
        fmt(card)
        add_save(card, s["simple"])
        finish(card)

        # Several saves of every kind, then one deleted.
        card = OUT / "multi-8mb.ps2"
        fmt(card)
        for key in ("simple", "japanese", "icons", "big", "ps1", "hidden"):
            add_save(card, s[key])
        mymc(card, "add", str(s["loose_file"]))
        mymc(card, "set", "-p", s["japanese"].name)
        mymc(card, "set", "-P", s["ps1"].name)
        mymc(card, "set", "-H", s["hidden"].name)
        mymc(card, "delete", s["big"].name)
        finish(card)

        # Delete a save in the middle so a later save reuses the gap and continues past it.
        card = OUT / "fragmented-8mb.ps2"
        fmt(card)
        for key in ("small_a", "simple", "small_c"):
            add_save(card, s[key])
        mymc(card, "delete", s["small_a"].name)
        add_save(card, s["grower"])
        finish(card)

        card = OUT / "full-8mb.ps2"
        fmt(card)
        add_save(card, s["simple"])
        fill_card(card, tmp, rng)
        finish(card)

        for size in (16, 32, 64):
            card = OUT / f"one-save-{size}mb.ps2"
            fmt(card, size)
            add_save(card, s["icons"])
            finish(card)

        card = OUT / "no-ecc-8mb.ps2"
        fmt(card, ecc=False)
        for key in ("simple", "japanese", "icons"):
            add_save(card, s[key])
        finish(card)

        # Save files for import tests, exported from a card that has the save.
        src = OUT / "multi-8mb.ps2"
        for flag, ext in (("-p", "psu"), ("-m", "max")):
            out = OUT / f"three-icons.{ext}"
            mymc(src, "export", flag, "-o", str(out), s["icons"].name)
            print(f"  {out.name}")

    for card in OUT.glob("*.ps2"):
        card.unlink()


if __name__ == "__main__":
    main()
