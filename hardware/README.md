# Hardware

> Lithium cells and power electronics are dangerous. See the disclaimer in the root [README](../README.md). Build and use at your own risk.

## Files in this folder

| File / folder | What it is |
|---------------|------------|
| [`gerber/capacity-tester-v1-gerber.zip`](gerber/capacity-tester-v1-gerber.zip) | **Order PCBs with this** — Gerber + drill package (6-layer) |
| [`easyeda/capacity-tester-v1-easyeda-source.zip`](easyeda/capacity-tester-v1-easyeda-source.zip) | **Edit the design** — EasyEDA schematic + PCB JSON source |
| [`bom/`](bom/) | Bill of materials (when available) |
| [`mechanical/`](mechanical/) | Heatsink CAD (when available) |

### OSHWLab link (may be pending)

https://oshwlab.com/team_zpyafgse/project_tiylojme

OSHWLab sometimes leaves new projects in a review / pending state. While that happens the page can **404 for visitors**. Prefer the zip files in this repo; treat OSHWLab as an optional mirror once it becomes public.

---

## How to order a PCB (Gerber zip)

1. Download [`gerber/capacity-tester-v1-gerber.zip`](gerber/capacity-tester-v1-gerber.zip).
2. Upload that zip to a fabricator that accepts Gerbers (JLCPCB, PCBWay, etc.).
3. Confirm the order settings match the design — this board is **6-layer**.
4. Optionally preview the Gerbers first in a free viewer such as [gerber-viewer.com](https://www.gerber-viewer.com/) or your fab’s online Gerber viewer before paying.

Do **not** upload the EasyEDA source zip to the fabricator; they need the Gerber package.

---

## How to open / edit the design (EasyEDA source zip)

1. Download [`easyeda/capacity-tester-v1-easyeda-source.zip`](easyeda/capacity-tester-v1-easyeda-source.zip) and unzip it.
2. Open the [EasyEDA editor](https://easyeda.com/editor) (Std) or EasyEDA Pro.
3. **File → Open → EasyEDA…**
4. Open the schematic `.json`, then the PCB `.json`.
5. Save them into a project in your EasyEDA account if you want to keep editing.

That source zip is for viewing and modifying the design. To manufacture after edits, export a new Gerber zip from the PCB in EasyEDA (**Fabrication → PCB Fabrication File**).

---

## Differences from the YouTube video

The current design includes these fixes relative to the board shown in the video:

- **MOSFET drain/source orientation** — corrected on all three MOSFETs (they were inverted in the video revision).
- **Reverse-protection FETs** — the back-to-back MOSFET reverse-protection arrangement was removed.
- **Voltage sense** — the sense path connects directly to the INA input **before the fuse**, for a more accurate measurement.
- **Fan capacitors** — moved from after the fan MOSFET to before the MOSFET.

## Planned improvements

Not in the current board yet:

- Larger cell-input pads for broader cell-holder compatibility
- DC jack input rated for 5 A
- Additional status LED
- User button
- Buzzer
