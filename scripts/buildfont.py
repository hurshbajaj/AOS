from pathlib import Path

from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets" / "fonts"
OUT = ROOT / "assets" / "fonts"

FAMILY = "AOS Console"
BAKE = ("ss01", "ss02", "ss03", "ss04", "tnum")
SLASH_SOURCE = "slashlongcomb.case"
SLASH_DX = 80  
SLASH_SCALE = 1.0  
WEIGHTS = ["Light", "Regular", "Medium", "Bold", "Black"]
FACES = WEIGHTS + [("Italic" if w == "Regular" else f"{w}Italic") for w in WEIGHTS]


def substitutions(font, tags):
    gsub = font["GSUB"].table
    wanted = set(tags)
    indices = []
    for record in gsub.FeatureList.FeatureRecord:
        if record.FeatureTag in wanted:
            indices.extend(record.Feature.LookupListIndex)

    mapping = {}
    for index in indices:
        for subtable in gsub.LookupList.Lookup[index].SubTable:
            mapping.update(getattr(subtable, "mapping", {}) or {})
    return mapping


def add_slashed_zero(font):
    glyphs = font.getGlyphSet()
    base = "zero.tf" if "zero.tf" in glyphs else "zero"
    if SLASH_SOURCE not in glyphs:
        return base

    width = font["hmtx"][base][0]
    pen = T2CharStringPen(width, glyphs)
    glyphs[base].draw(pen)
    cx, cy = 249.5, 358.0
    shift = SLASH_DX + cx * (1 - SLASH_SCALE)
    rise = cy * (1 - SLASH_SCALE)
    glyphs[SLASH_SOURCE].draw(TransformPen(pen, (SLASH_SCALE, 0, 0, SLASH_SCALE, shift, rise)))

    top = font["CFF "].cff[font["CFF "].cff.fontNames[0]]
    top.CharStrings[base] = pen.getCharString(private=top.Private)
    return base


def rebrand(font, face):
    style = "Italic" if face.endswith("Italic") else "Regular"
    weight = face.replace("Italic", "") or "Regular"
    subfamily = f"{weight} Italic".strip() if face.endswith("Italic") else weight
    full = f"{FAMILY} {subfamily}"
    postscript = f"{FAMILY.replace(' ', '')}-{subfamily.replace(' ', '')}"

    values = {
        1: FAMILY if weight in ("Regular", "Bold") else f"{FAMILY} {weight}",
        2: style if weight in ("Regular", "Bold") else ("Italic" if face.endswith("Italic") else "Regular"),
        3: f"{postscript};AOS",
        4: full,
        6: postscript,
        10: "Instrument cut: baked single-storey a/g, alternate G/t/Q, tabular figures and a slashed zero.",
        16: FAMILY,
        17: subfamily,
    }

    table = font["name"]
    for name_id, value in values.items():
        table.setName(value, name_id, 3, 1, 0x409)
        table.setName(value, name_id, 1, 0, 0)

    credit = "Derived from Satoshi by Indian Type Foundry (Fontshare)."
    for name_id in (0, 11, 12):
        table.setName(credit, name_id, 3, 1, 0x409)


def build(face):
    source = SRC / f"Satoshi-{face}.woff2"
    if not source.exists():
        return None

    font = TTFont(source)
    swaps = substitutions(font, BAKE)
    swaps["zero"] = add_slashed_zero(font)
    swaps.pop("zero.tf", None)

    order = set(font.getGlyphOrder())
    repointed = 0
    for table in font["cmap"].tables:
        for codepoint, glyph in list(table.cmap.items()):
            target = swaps.get(glyph)
            if target and target in order:
                table.cmap[codepoint] = target
                repointed += 1

    rebrand(font, face)
    font.flavor = "woff2"
    destination = OUT / f"AOSConsole-{face}.woff2"
    font.save(destination)
    return destination, repointed, destination.stat().st_size


def main():
    print(f"{FAMILY} — baking {', '.join(BAKE)} + slashed zero\n")
    for face in FACES:
        result = build(face)
        if not result:
            print(f"  skip  Satoshi-{face}.woff2 (not present)")
            continue
        path, repointed, size = result
        print(f"  ok    {path.name:34} {repointed:3} codepoints repointed  {size / 1024:5.1f} KB")


if __name__ == "__main__":
    main()
