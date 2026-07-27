import json
import os
import select
import threading
import time
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

import serial
import websocket

try:
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore

try:
    import termios
except ImportError:  # pragma: no cover - non-POSIX
    termios = None  # type: ignore

PORT = os.environ.get("YR1035_PORT", "/dev/cu.usbserial-10")
BAUD = 9600
FRAME_SIZE = 18
HEADER = b"\x78\x02"
HUB_URL = os.environ.get("HUB_URL", "http://localhost:3001").rstrip("/")
# If the adapter stops delivering bytes, try recovery (common CP2102/macOS stall).
SERIAL_STALE_S = float(os.environ.get("YR1035_STALE_S", "5"))
SERIAL_READ_TIMEOUT_S = 0.25


def hub_ws_url(hub_url: str) -> str:
    explicit = os.environ.get("HUB_WS", "").strip()
    if explicit:
        return explicit
    parsed = urlparse(hub_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return f"{scheme}://{parsed.netloc}"


def _pulse_lines(ser: serial.Serial) -> None:
    """Wake CP2102 / meter link; some adapters need DTR/RTS asserted to stream."""
    try:
        ser.dtr = False
        ser.rts = False
        time.sleep(0.05)
        ser.dtr = True
        ser.rts = True
        time.sleep(0.05)
    except Exception:
        pass


def open_serial_port(port: str, baud: int, timeout: float = 0.2) -> serial.Serial:
    """Open a serial port, working around macOS CP2102 termios EINVAL on reconfigure."""
    try:
        ser = serial.Serial(
            port=port,
            baudrate=baud,
            timeout=timeout,
            write_timeout=timeout,
            rtscts=False,
            dsrdtr=False,
            xonxoff=False,
        )
    except Exception as exc:
        # pyserial raises termios.error on some macOS USB-UART drivers while applying
        # baud/parity via tcsetattr. Skip reconfigure; use select()-gated reads instead.
        if termios is None or not isinstance(exc, termios.error):
            raise

        class _MacSerial(serial.Serial):
            def _reconfigure_port(self, force_update: bool = False) -> None:
                return

        ser = _MacSerial(
            port=port,
            baudrate=baud,
            timeout=timeout,
            write_timeout=timeout,
            rtscts=False,
            dsrdtr=False,
            xonxoff=False,
        )
        print(
            f"Opened {port} with macOS CP2102 workaround "
            f"(skipped termios reconfigure: {exc})"
        )

    # Keep the fd blocking. O_NONBLOCK + this driver often yields zero bytes forever.
    # select() still provides a read timeout without changing fd flags.
    if fcntl is not None and getattr(ser, "fd", None) is not None:
        try:
            flags = fcntl.fcntl(ser.fd, fcntl.F_GETFL)
            if flags & os.O_NONBLOCK:
                fcntl.fcntl(ser.fd, fcntl.F_SETFL, flags & ~os.O_NONBLOCK)
        except Exception:
            pass

    _pulse_lines(ser)
    try:
        ser.reset_input_buffer()
    except Exception:
        pass
    return ser


def open_serial_with_retry(port: str, baud: int) -> serial.Serial:
    while True:
        try:
            return open_serial_port(port, baud, timeout=SERIAL_READ_TIMEOUT_S)
        except Exception as exc:
            print(f"Serial open failed ({exc}); retrying in 1s…")
            time.sleep(1.0)


def read_serial_bytes(ser: serial.Serial, timeout_s: float) -> bytes:
    """Read available bytes, waiting up to timeout_s (via select, not termios VTIME)."""
    fd = getattr(ser, "fd", None)
    if fd is None:
        waiting = ser.in_waiting
        return bytes(ser.read(waiting or 1))

    try:
        ready, _, _ = select.select([fd], [], [], timeout_s)
    except (ValueError, OSError) as exc:
        raise serial.SerialException(f"serial fd not selectable: {exc}") from exc

    if not ready:
        return b""

    try:
        waiting = int(ser.in_waiting or 0)
    except Exception:
        waiting = 0

    try:
        if waiting > 0:
            return bytes(ser.read(waiting))
        # select reported readability; drain whatever the driver has.
        return os.read(fd, 1024)
    except BlockingIOError:
        return b""
    except OSError as exc:
        raise serial.SerialException(str(exc)) from exc


def recover_serial(ser: serial.Serial, port: str, baud: int) -> serial.Serial:
    """Try to unstick the adapter without requiring a physical unplug."""
    print("Serial stalled — pulsing DTR/RTS, then reopening…")
    try:
        _pulse_lines(ser)
        ser.reset_input_buffer()
    except Exception:
        pass
    try:
        ser.close()
    except Exception:
        pass
    time.sleep(0.3)
    return open_serial_with_retry(port, baud)


@dataclass
class Measurement:
    resistance_ohms: Optional[float]
    resistance_display: str
    voltage: Optional[float]
    checksum: int
    raw_frame: bytes
    status: str  # ok | ol | settling


def _is_dashes(text: str) -> bool:
    return bool(text) and set(text) <= {"-"}


def parse_frame(frame: bytes) -> Optional[Measurement]:
    if len(frame) != FRAME_SIZE or frame[:2] != HEADER:
        return None

    # Fixed-width fields:
    # Bytes 2–9:  resistance, for example "06.48mR ", "  OL mR ", "-----mR ", "----- R "
    # Bytes 10–16: voltage, for example "3.2525V", ".00274V", "------V"
    resistance_field = frame[2:10].decode("ascii", errors="replace")
    voltage_field = frame[10:17].decode("ascii", errors="replace")
    checksum = frame[17]

    if not voltage_field.endswith("V"):
        print(f"Invalid voltage field: {voltage_field!r}")
        return None

    voltage_text = voltage_field[:-1].strip()
    voltage: Optional[float]
    voltage_settling = _is_dashes(voltage_text)
    if voltage_settling:
        voltage = None
    else:
        try:
            voltage = float(voltage_text)
        except ValueError:
            print(f"Cannot parse voltage: {voltage_field!r}")
            return None

    resistance_text = resistance_field.strip()

    if not resistance_text.endswith("R"):
        print(f"Invalid resistance field: {resistance_field!r}")
        return None

    resistance_text = resistance_text[:-1].strip()

    unit = ""
    if resistance_text.endswith(("m", "k")):
        unit = resistance_text[-1]
        resistance_text = resistance_text[:-1].strip()

    if resistance_text == "OL":
        return Measurement(
            resistance_ohms=None,
            resistance_display="OL",
            voltage=voltage,
            checksum=checksum,
            raw_frame=frame,
            status="ol",
        )

    if _is_dashes(resistance_text) or voltage_settling:
        return Measurement(
            resistance_ohms=None,
            resistance_display="---",
            voltage=voltage,
            checksum=checksum,
            raw_frame=frame,
            status="settling",
        )

    try:
        resistance_value = float(resistance_text)
    except ValueError:
        print(f"Cannot parse resistance: {resistance_field!r}")
        return None

    multipliers = {
        "": 1.0,
        "m": 1e-3,
        "k": 1e3,
    }

    resistance_ohms = resistance_value * multipliers[unit]

    display_units = {
        "": "Ω",
        "m": "mΩ",
        "k": "kΩ",
    }

    return Measurement(
        resistance_ohms=resistance_ohms,
        resistance_display=f"{resistance_value:g} {display_units[unit]}",
        voltage=voltage,
        checksum=checksum,
        raw_frame=frame,
        status="ok",
    )


class HubWsBridge:
    """Persistent WebSocket; never blocks the serial loop on send."""

    def __init__(self, ws_url: str) -> None:
        self._ws_url = ws_url
        self._lock = threading.Lock()
        self._ws: Optional[websocket.WebSocketApp] = None
        self._connected = threading.Event()
        self._stop = threading.Event()
        self._pending: Optional[str] = None
        self._wake = threading.Event()
        self._thread = threading.Thread(target=self._run, name="hub-ws", daemon=True)
        self._sender = threading.Thread(target=self._send_loop, name="hub-ws-send", daemon=True)

    def start(self) -> None:
        self._thread.start()
        self._sender.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        with self._lock:
            ws = self._ws
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass
        self._thread.join(timeout=2.0)
        self._sender.join(timeout=2.0)

    def wait_connected(self, timeout: float = 5.0) -> bool:
        return self._connected.wait(timeout)

    def send(self, measurement: Measurement) -> None:
        ir_mohm = (
            None
            if measurement.resistance_ohms is None
            else round(measurement.resistance_ohms * 1000.0, 3)
        )
        payload = {
            "type": "meter_reading",
            "status": measurement.status,
            "irMohm": ir_mohm,
            "voltageV": (
                None if measurement.voltage is None else round(measurement.voltage, 5)
            ),
            "resistanceDisplay": measurement.resistance_display,
        }
        with self._lock:
            self._pending = json.dumps(payload)
        self._wake.set()

    def _send_loop(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(timeout=0.5)
            self._wake.clear()
            while not self._stop.is_set():
                with self._lock:
                    raw = self._pending
                    self._pending = None
                    ws = self._ws
                    connected = self._connected.is_set()
                if raw is None:
                    break
                if not connected or ws is None:
                    continue
                try:
                    ws.send(raw)
                except Exception as exc:
                    print(f"Hub WS send failed: {exc}")

    def _run(self) -> None:
        while not self._stop.is_set():
            self._connected.clear()

            def on_open(_ws: websocket.WebSocketApp) -> None:
                print(f"Hub WS connected: {self._ws_url}")
                self._connected.set()

            def on_close(_ws: websocket.WebSocketApp, status: int, msg: str) -> None:
                self._connected.clear()
                if not self._stop.is_set():
                    print(f"Hub WS closed ({status} {msg}); reconnecting…")

            def on_error(_ws: websocket.WebSocketApp, error: Exception) -> None:
                if not self._stop.is_set():
                    print(f"Hub WS error: {error}")

            app = websocket.WebSocketApp(
                self._ws_url,
                on_open=on_open,
                on_close=on_close,
                on_error=on_error,
            )
            with self._lock:
                self._ws = app

            app.run_forever(ping_interval=20, ping_timeout=10)
            with self._lock:
                self._ws = None
            self._connected.clear()
            if not self._stop.is_set():
                time.sleep(1.0)


def main() -> None:
    buffer = bytearray()
    ws_url = hub_ws_url(HUB_URL)
    bridge = HubWsBridge(ws_url)
    bridge.start()

    ser = open_serial_with_retry(PORT, BAUD)
    print(f"Reading {PORT} at {BAUD} baud → {ws_url}")
    if not bridge.wait_connected(5.0):
        print("Waiting for hub WebSocket… (will keep retrying)")

    last_byte_at = time.monotonic()
    ever_got_data = False
    stall_notice_at = 0.0

    try:
        while True:
            try:
                chunk = read_serial_bytes(ser, SERIAL_READ_TIMEOUT_S)
            except (serial.SerialException, OSError) as exc:
                print(f"Serial read error ({exc}); recovering…")
                ser = recover_serial(ser, PORT, BAUD)
                buffer.clear()
                last_byte_at = time.monotonic()
                continue

            if chunk:
                ever_got_data = True
                last_byte_at = time.monotonic()
                buffer.extend(chunk)
            elif time.monotonic() - last_byte_at >= SERIAL_STALE_S:
                # Don't thrash before the first byte — ask for a USB re-seat instead.
                if not ever_got_data:
                    now = time.monotonic()
                    if now - stall_notice_at >= 10.0:
                        stall_notice_at = now
                        print(
                            "Port is open but no bytes yet. Unplug/replug the USB "
                            "adapter once, or power-cycle the meter."
                        )
                    continue

                ser = recover_serial(ser, PORT, BAUD)
                buffer.clear()
                last_byte_at = time.monotonic()
                continue

            while True:
                start = buffer.find(HEADER)

                if start == -1:
                    buffer[:] = buffer[-1:] if buffer[-1:] == b"\x78" else b""
                    break

                if start:
                    del buffer[:start]

                if len(buffer) < FRAME_SIZE:
                    break

                frame = bytes(buffer[:FRAME_SIZE])
                del buffer[:FRAME_SIZE]

                measurement = parse_frame(frame)

                if measurement is None:
                    print("Bad frame:", frame.hex(" "))
                    continue

                if measurement.voltage is None:
                    print(
                        f"Resistance: {measurement.resistance_display} | "
                        f"Voltage: ---"
                    )
                else:
                    print(
                        f"Resistance: {measurement.resistance_display} | "
                        f"Voltage: {measurement.voltage:.5f} V"
                    )
                bridge.send(measurement)

    except KeyboardInterrupt:
        print("\nStopped")
    finally:
        try:
            ser.close()
        except Exception:
            pass
        bridge.stop()


if __name__ == "__main__":
    main()
