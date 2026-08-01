# Hardware

**Schematic and PCB (OSHWLab / EasyEDA):**  
https://oshwlab.com/team_zpyafgse/project_tiylojme

That project is the source of truth for the board. Use it to view the schematic, PCB, and order fabrication.

> Lithium cells and power electronics are dangerous. See the disclaimer in the root [README](../README.md). Build and use at your own risk.

---

## Differences from the YouTube video

The published OSHWLab design includes these fixes relative to the board shown in the video:

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

## Mechanical

A custom heatsink was designed for this project in Fusion 360. CAD files are not in the repo yet; when published, they will appear under [`mechanical/`](mechanical/).
