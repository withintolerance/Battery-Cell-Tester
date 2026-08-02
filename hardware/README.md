# Hardware

> Lithium cells and power electronics are dangerous. See the disclaimer in the root [README](../README.md). Build and use at your own risk.

## Where to get the design

**Primary (this repo):** fabrication files and exports live in the folders below once published.

| Folder | Contents |
|--------|----------|
| [`gerber/`](gerber/) | Gerber + drill zip for ordering PCBs |
| [`schematic/`](schematic/) | Schematic PDF (and EasyEDA source if available) |
| [`bom/`](bom/) | Bill of materials |
| [`mechanical/`](mechanical/) | Heatsink CAD (when available) |

**OSHWLab / EasyEDA** (optional mirror — may be delayed by their review queue):  
https://oshwlab.com/team_zpyafgse/project_tiylojme

If that page 404s or shows as pending, use the files in this repo instead.

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
