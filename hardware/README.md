# Hardware (EasyEDA + mechanical)

**Schematic & PCB (share this link):**  
https://oshwlab.com/team_zpyafgse/project_tiylojme

Open that OSHWLab / EasyEDA project for the live schematic and PCB. This folder holds revision notes, TODOs, and mechanical files (e.g. heatsink).

> Lithium cells and power electronics are dangerous. See the disclaimer in the root [README](../README.md). Build and use at your own risk.

## Suggested layout

```text
hardware/
├── README.md
├── schematic/          # Schematic exports (PDF / EasyEDA source)
├── pcb/                # PCB source / board preview images
├── gerber/             # Gerber + drill zip for manufacturing
├── bom/                # Bill of materials (CSV / Excel)
└── mechanical/         # Heatsink and other 3D models (Fusion 360, STEP)
```

Create those folders as you export files. Keep revision names clear, e.g. `tester-v1-gerber.zip`.

---

## PCB revision notes (post-video fixes)

Compared with the board shown in the video, the current design has these fixes:

- **MOSFET drain/source orientation** — corrected on **all three** MOSFETs (they were inverted in the video revision).
- **Reverse-protection FETs** — removed the back-to-back MOSFET reverse-protection arrangement.
- **Voltage sense** — sense wire now connects **directly to the INA** input **before the fuse**, for a more accurate measurement (avoids fuse drop).
- **Fan capacitors** — moved from **after** the fan MOSFET to **before** the MOSFET.

### Still TODO on the next PCB spin

- [ ] Change the cell input pads to a **larger pad** so more cell-holder styles fit.
- [ ] Add a **DC jack** input rated for **5 A**.
- [ ] Add **another LED**.
- [ ] Add a **user button**.
- [ ] Add a **buzzer**.

---

## Heatsink (Fusion 360)

The custom heatsink for this project belongs in `hardware/mechanical/`.

Export from Fusion 360 and commit both when possible:

1. **Fusion archive** — **File → Export → Archive File (.f3d)** (editable source).
2. **STEP** (optional but useful) — **File → Export → STEP (.step)** so people can open it without Fusion.

Suggested names:

```text
hardware/mechanical/heatsink-v1.f3d
hardware/mechanical/heatsink-v1.step
```

Drop the exported file(s) into `hardware/mechanical/`, then commit and push (or ask the agent to).

---

## Exporting from EasyEDA (Std / Pro)

### 1. Project source (best for others to edit)

**EasyEDA Std**

1. Open the project → **File → Export → EasyEDA Source…** (or save/export the project JSON).
2. Put the exported files under `hardware/pcb/` and/or `hardware/schematic/`.

**EasyEDA Pro**

1. Open the design → **File → Export → EasyEDA…** / project package for the editor you use.
2. Commit the exported project package (not only screenshots).

### 2. Gerbers (for ordering PCBs)

1. Open the PCB → **Fabrication → PCB Fabrication File (Gerber)** (wording varies slightly by Std/Pro).
2. Generate the Gerber + drill archive (often a `.zip`).
3. Place it in `hardware/gerber/` (example: `hardware/gerber/tester-v1.zip`).

That zip is what fabs like JLCPCB / PCBWay expect.

### 3. BOM

1. From the schematic or PCB, export **Bill of Materials** as CSV.
2. Save under `hardware/bom/` (example: `hardware/bom/tester-v1.csv`).

### 4. Schematic PDF (optional but helpful)

1. Export schematic as PDF.
2. Save under `hardware/schematic/` so people can read the design without EasyEDA.

### 5. Do **not** commit

- Local EasyEDA autosave / cache folders
- Temporary export folders full of duplicates
- Personal order invoices or JLCPCB account details
- Fusion cloud-only links without an exported `.f3d` / `.step` file

## After exporting

From the repo root:

```bash
# copy your exports into hardware/… then:
git add hardware/
git status   # confirm only the design files you intend
git commit -m "Add EasyEDA hardware files for tester v1"
git -c credential.helper='!gh auth git-credential' push
```

Or drop the files into `hardware/` in Finder / Cursor and ask the agent to commit and push.
