# Go-Kart Battery Cell Tester

Open-source multi-bay lithium cell charge/discharge tester: ESP32-S2 firmware, hub API, web dashboard, and PCB design.

**Watch the build / overview video:** https://youtu.be/NCjXZjViC6E

> **Disclaimer — use at your own risk**
>
> This project works with **lithium cells**, which can catch fire, explode, or cause serious injury or property damage if mishandled, shorted, overcharged, over-discharged, or used with a faulty build.
>
> The designs, firmware, and software are provided **as-is, with no warranty**. By using this project you accept full responsibility for your build, testing, and operation. **The author(s) take no responsibility** for any damage, injury, loss, or other consequences that may result from using or modifying this project.
>
> If you are not comfortable working with lithium batteries and power electronics, do not build or use this.

## Hardware (PCB)

Full details: [`hardware/README.md`](hardware/README.md)

| File | Use it for |
|------|------------|
| [`hardware/gerber/capacity-tester-v1-gerber.zip`](hardware/gerber/capacity-tester-v1-gerber.zip) | **Ordering PCBs** — upload this Gerber zip to your preferred PCB house (**6-layer**) |
| [`hardware/easyeda/capacity-tester-v1-easyeda-source.zip`](hardware/easyeda/capacity-tester-v1-easyeda-source.zip) | **Editing the design** — open the JSON files in EasyEDA (**File → Open → EasyEDA…**) |

**Quick order path:** download the Gerber zip → upload to your fab → set **6 layers**. Optionally preview the zip in a Gerber viewer first.

**Quick edit path:** unzip the EasyEDA source → EasyEDA → **File → Open → EasyEDA…** → open schematic JSON, then PCB JSON → save into a project.

### OSHWLab (may be pending / 404)

https://oshwlab.com/team_zpyafgse/project_tiylojme

OSHWLab can leave projects in review. While pending, the public page often **404s**. Use the zip files above instead; check OSHWLab again later if you prefer their online viewer.

## What’s in this repo

| Part | Path | Role |
|------|------|------|
| **Firmware** | `src/`, `include/`, `platformio.ini` | Runs on each ESP32-S2 tester board |
| **Hub** | `hub/` | API, SQLite history, board polling, alerts |
| **UI** | `ui/` | Next.js dashboard (port 3000 → hub on 3001) |
| **Hardware** | [`hardware/`](hardware/) | Gerbers, EasyEDA source, PCB notes |

Optional: `YR1035_reader/` streams IR/voltage readings from a YR1035 meter into the hub.

---

## Requirements

- [PlatformIO](https://platformio.org/) (VS Code extension or CLI) for firmware
- Node.js 20+ for hub and UI
- Python 3.10+ only if you use the YR1035 bridge
- A LAN where the hub host and ESP32 boards can reach each other

---

## Quick start

### 1. Hub

```bash
cd hub
cp .env.example .env          # optional: Home Assistant webhooks
cp config.json.example config.json   # optional; hub creates defaults if missing
npm install
npm start
```

Hub listens on **http://localhost:3001** (override with `PORT`).

Board IPs start empty. Add them in the UI **Settings** panel (left → right order matches the physical bays).

### 2. UI

In another terminal:

```bash
cd ui
npm install
npm run dev          # development
# or: npm run build && npm start   # production
```

Open **http://localhost:3000**.

By default the UI talks to `http://localhost:3001`. If the hub runs on another machine, copy `ui/.env.local.example` → `ui/.env.local` and set:

```bash
NEXT_PUBLIC_HUB_URL=http://YOUR_HUB_IP:3001
NEXT_PUBLIC_HUB_WS=ws://YOUR_HUB_IP:3001
```

From the repo root you can also use `npm run install:all`, `npm run hub`, and `npm run ui:dev`.

### 3. Firmware (each board)

1. Connect the ESP32-S2 over USB.
2. Build and flash:

```bash
pio run -t upload
pio device monitor
```

3. Configure Wi-Fi and hub URL over serial (115200 baud):

```text
wifi set <ssid> <password>
wifi hub http://YOUR_HUB_IP:3001
wifi status
```

When connected, the board prints its IP. Add that IP under **Settings → Boards** in the UI.

#### Optional compile-time Wi-Fi defaults

To bake defaults into a fresh flash, copy the example and edit locally:

```bash
cp include/wifi_defaults_private.h.example include/wifi_defaults_private.h
```

Set SSID, password, and hub URL, then rebuild. Keep credentials in that private header on your machine only (it is gitignored). Values saved later with `wifi set` / `wifi hub` override these defaults.

---

## First-time dashboard setup

1. Start hub + UI.
2. Open Settings.
3. Add each board IP in **left → right** physical order.
4. Set the pass threshold (mAh) if needed.
5. Start a test from a channel card or use **Start All**.

---

## Optional: YR1035 IR meter bridge

```bash
cd YR1035_reader
pip install -r requirements.txt
HUB_URL=http://YOUR_HUB_IP:3001 python main.py
```

Readings appear on the UI `/ir` page. Override the WebSocket URL with `HUB_WS` if needed.

---

## Optional: Home Assistant / Alexa alerts

When every occupied bay is finished (`COMPLETE` or `FAULT`), the hub can POST once to a Home Assistant webhook. Out-of-range telemetry can use the same (or a dedicated) webhook.

1. In `hub/.env`:

```bash
HOME_ASSISTANT_SWAP_WEBHOOK_URL=http://homeassistant.local:8123/api/webhook/battery-tester-swap
# Optional:
# HOME_ASSISTANT_THERMAL_WEBHOOK_URL=http://homeassistant.local:8123/api/webhook/battery-tester-thermal
```

2. Example Home Assistant automation:

```yaml
alias: Battery tester cells ready
trigger:
  - platform: webhook
    webhook_id: battery-tester-swap
    allowed_methods:
      - POST
    local_only: true
action:
  - service: notify.alexa_media_everywhere
    data:
      message: "{{ trigger.json.message }}"
      data:
        type: announce
```

Restart the hub after changing `.env`. Use **Settings → Send test alert** in the UI to verify.

Range alerts (edge-triggered, with hysteresis on temperatures):

- Cell temperature outside **15–38 °C** (occupied bays)
- Heatsink temperature outside **15–50 °C**
- Cell voltage outside the chemistry charge/cutoff window (±150 mV)
- Invalid cell temperature sensor on an occupied bay

---

## Deploying hub + UI on a server

```bash
# Hub
cd hub && npm install && npm start

# UI (separate process)
cd ui && npm install && npm run build && npm start
```

Keep both processes running with systemd, PM2, or similar. Across updates, preserve:

- `hub/data.db` (+ WAL/SHM) — history and board IP list
- `hub/config.json` — runtime settings
- `hub/.env` — secrets / webhooks

Useful URLs:

```text
http://HOST:3000          # dashboard
http://HOST:3000/history
http://HOST:3000/ir
http://HOST:3001/api/results
http://HOST:3001/api/runs
```

---

## Project layout

```text
├── src/ / include/     ESP32-S2 firmware (PlatformIO)
├── hub/                Express + SQLite API (port 3001)
├── ui/                 Next.js dashboard (port 3000)
├── hardware/           Gerbers, EasyEDA source, PCB notes
├── YR1035_reader/      Optional meter → hub bridge
└── platformio.ini
```

Hub and UI are separate packages on purpose: the hub is a long-running Node service with SQLite and WebSockets; the UI is a standard Next.js app.

---

## License

MIT — see [LICENSE](LICENSE). This license does **not** reduce the risks described in the disclaimer above; use of the project remains at your own risk.
