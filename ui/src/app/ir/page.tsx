"use client";

import Link from "next/link";
import {
  fetchIrMeasurements,
  fetchMeter,
  fetchNextIrCell,
  getApiBaseUrl,
  getWsUrl,
  saveCellIr,
} from "@/lib/api";
import { ensureAudioUnlockListeners, playSuccessSound, unlockAudio } from "@/lib/sounds";
import type { CellIrMeasurement, IrLimits, MeterReading } from "@/lib/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Continuous in-range hold time before accepting a reading. */
const STABLE_HOLD_MS = 2000;
/** Restart the hold if IR wanders this far from the hold's running median. */
const IR_HOLD_DRIFT_MOHM = 0.05;
/** Continuous OL/settling/out-of-range before treating the cell as removed. */
const CLEAR_HOLD_MS = 2000;
const DEFAULT_LIMITS: IrLimits = {
  irMinMohm: 5.5,
  irMaxMohm: 7.5,
  voltageMinV: 3.15,
  voltageMaxV: 3.35,
};

type Phase = "idle" | "measuring" | "waiting_clear" | "complete";

function roundIr(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function inRange(irMohm: number, voltageV: number, limits: IrLimits): boolean {
  return (
    irMohm >= limits.irMinMohm
    && irMohm <= limits.irMaxMohm
    && voltageV >= limits.voltageMinV
    && voltageV <= limits.voltageMaxV
  );
}

function isClearedReading(reading: MeterReading | null, limits: IrLimits): boolean {
  if (!reading) return false;
  if (reading.status === "ol" || reading.status === "settling" || reading.status === "invalid") {
    return true;
  }
  if (reading.status !== "ok" || reading.irMohm == null || reading.voltageV == null) {
    return true;
  }
  return !inRange(reading.irMohm, reading.voltageV, limits);
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

export default function IrTestPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [cellId, setCellId] = useState<number>(1);
  const [startFromInput, setStartFromInput] = useState("1");
  const [pendingCount, setPendingCount] = useState(0);
  const [reading, setReading] = useState<MeterReading | null>(null);
  const [limits, setLimits] = useState<IrLimits>(DEFAULT_LIMITS);
  const [stableProgress, setStableProgress] = useState(0);
  const [clearProgress, setClearProgress] = useState(0);
  const [isStable, setIsStable] = useState(false);
  const [measurements, setMeasurements] = useState<CellIrMeasurement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [meterConnected, setMeterConnected] = useState(false);
  const [manualIr, setManualIr] = useState("");
  const [manualVoltage, setManualVoltage] = useState("");
  const [busy, setBusy] = useState(false);

  const phaseRef = useRef<Phase>("idle");
  const cellIdRef = useRef(1);
  const limitsRef = useRef(limits);
  const holdSamplesRef = useRef<Array<{ irMohm: number; voltageV: number }>>([]);
  const holdStartedAtRef = useRef<number | null>(null);
  const clearStartedAtRef = useRef<number | null>(null);
  const advancingRef = useRef(false);
  const savingRef = useRef(false);
  const lastProcessedReadingAtRef = useRef<number | null>(null);
  const persistReadingRef = useRef<(params: {
    irMohm: number;
    voltageV: number;
    source: "meter" | "manual";
    skipValidation?: boolean;
  }) => Promise<void>>(async () => undefined);
  const advanceToNextCellRef = useRef<() => Promise<void>>(async () => undefined);

  const resetStability = useCallback(() => {
    holdSamplesRef.current = [];
    holdStartedAtRef.current = null;
    setStableProgress(0);
    setIsStable(false);
  }, []);

  const resetClearHold = useCallback(() => {
    clearStartedAtRef.current = null;
    setClearProgress(0);
  }, []);

  const updateHoldProgress = useCallback(() => {
    const startedAt = holdStartedAtRef.current;
    if (startedAt == null) {
      setStableProgress(0);
      setIsStable(false);
      return;
    }
    const elapsed = Date.now() - startedAt;
    const progress = Math.min(1, elapsed / STABLE_HOLD_MS);
    setStableProgress(progress);
    if (
      progress >= 1
      && holdSamplesRef.current.length >= 2
      && phaseRef.current === "measuring"
      && !savingRef.current
    ) {
      const samples = holdSamplesRef.current;
      setIsStable(true);
      void persistReadingRef.current({
        irMohm: roundIr(median(samples.map((sample) => sample.irMohm))),
        voltageV: median(samples.map((sample) => sample.voltageV)),
        source: "meter",
      });
    }
  }, []);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    cellIdRef.current = cellId;
  }, [cellId]);

  useEffect(() => {
    limitsRef.current = limits;
  }, [limits]);

  // Browsers block Web Audio until a user gesture; unlock on any click/key.
  useEffect(() => {
    ensureAudioUnlockListeners();
  }, []);

  const refreshMeasurements = useCallback(async () => {
    const data = await fetchIrMeasurements();
    setMeasurements(data.measurements);
    setLimits(data.limits);
  }, []);

  const refreshNextDefault = useCallback(async () => {
    const from = Math.max(1, Math.floor(Number(startFromInput) || 1));
    const next = await fetchNextIrCell(from);
    setPendingCount(next.pendingCount);
    if (next.nextCellId != null) {
      setStartFromInput(String(next.nextCellId));
      if (phaseRef.current === "idle") {
        setCellId(next.nextCellId);
      }
    }
  }, [startFromInput]);

  useEffect(() => {
    const boot = setTimeout(() => {
      void Promise.all([fetchMeter(), fetchIrMeasurements(), fetchNextIrCell(1)])
        .then(([meter, ir, next]) => {
          setReading(meter.reading);
          setLimits(meter.limits ?? ir.limits);
          setMeasurements(ir.measurements);
          setPendingCount(next.pendingCount);
          if (next.nextCellId != null) {
            setStartFromInput(String(next.nextCellId));
            setCellId(next.nextCellId);
          }
          if (meter.reading) {
            setMeterConnected(Date.now() - meter.reading.receivedAtMs < 5000);
          }
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Failed to reach Hub API");
        });
    }, 0);

    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connectWs = () => {
      ws = new WebSocket(getWsUrl());
      ws.onopen = () => {
        setError(null);
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as { type?: string; data?: MeterReading | null };
          if (msg.type === "meter") {
            setReading(msg.data ?? null);
            setMeterConnected(true);
          }
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        setMeterConnected(false);
        reconnectTimer = setTimeout(connectWs, 2000);
      };
      ws.onerror = () => {
        ws.close();
      };
    };

    connectWs();

    return () => {
      clearTimeout(boot);
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, []);

  const advanceToNextCell = useCallback(async () => {
    const from = cellIdRef.current + 1;
    try {
      const next = await fetchNextIrCell(from);
      setPendingCount(next.pendingCount);
      resetClearHold();
      if (next.nextCellId == null) {
        setPhase("complete");
        setStatusMessage("All known cells have IR measurements.");
        resetStability();
        return;
      }
      setCellId(next.nextCellId);
      setStartFromInput(String(next.nextCellId));
      setPhase("measuring");
      setStatusMessage(`Insert cell #${next.nextCellId}`);
      resetStability();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to get next cell");
      setPhase("idle");
      resetClearHold();
    }
  }, [resetStability, resetClearHold]);

  const persistReading = useCallback(
    async (params: {
      irMohm: number;
      voltageV: number;
      source: "meter" | "manual";
      skipValidation?: boolean;
    }) => {
      if (savingRef.current) return;
      savingRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const result = await saveCellIr({
          cellId: cellIdRef.current,
          irMohm: params.irMohm,
          voltageV: params.voltageV,
          source: params.source,
          skipValidation: params.skipValidation,
        });
        void playSuccessSound();
        await refreshMeasurements();
        const next = await fetchNextIrCell(1);
        setPendingCount(next.pendingCount);
        setPhase("waiting_clear");
        resetStability();
        resetClearHold();
        setStatusMessage(
          `Saved cell #${result.measurement.cellId}: `
            + `${result.measurement.irMohm.toFixed(2)} mΩ @ `
            + `${result.measurement.voltageV.toFixed(3)} V — remove cell `
            + `(need OL for ${CLEAR_HOLD_MS / 1000}s)`,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save IR");
        setPhase("measuring");
      } finally {
        savingRef.current = false;
        setBusy(false);
      }
    },
    [refreshMeasurements, resetStability, resetClearHold],
  );

  useEffect(() => {
    persistReadingRef.current = persistReading;
  }, [persistReading]);

  useEffect(() => {
    advanceToNextCellRef.current = advanceToNextCell;
  }, [advanceToNextCell]);

  const updateClearProgress = useCallback(() => {
    if (phaseRef.current !== "waiting_clear" || advancingRef.current) {
      return;
    }
    const startedAt = clearStartedAtRef.current;
    if (startedAt == null) {
      setClearProgress(0);
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / CLEAR_HOLD_MS);
    setClearProgress(progress);
    if (progress >= 1) {
      advancingRef.current = true;
      void advanceToNextCellRef.current().finally(() => {
        advancingRef.current = false;
      });
    }
  }, []);

  useEffect(() => {
    if (phase !== "measuring" && phase !== "waiting_clear") return;
    const timer = setInterval(() => {
      if (phaseRef.current === "measuring") {
        updateHoldProgress();
      } else if (phaseRef.current === "waiting_clear") {
        updateClearProgress();
      }
    }, 50);
    return () => clearInterval(timer);
  }, [phase, updateHoldProgress, updateClearProgress]);

  useEffect(() => {
    if (!reading) return;
    if (lastProcessedReadingAtRef.current === reading.receivedAtMs) return;
    lastProcessedReadingAtRef.current = reading.receivedAtMs;

    const currentLimits = limitsRef.current;
    const currentPhase = phaseRef.current;

    if (currentPhase === "waiting_clear") {
      if (isClearedReading(reading, currentLimits)) {
        if (clearStartedAtRef.current == null) {
          clearStartedAtRef.current = Date.now();
        }
        updateClearProgress();
      } else {
        // Brief probe glitches / reseating must not count as a remove.
        resetClearHold();
      }
      return;
    }

    if (currentPhase !== "measuring") return;

    const irOk =
      reading.status === "ok"
      && reading.irMohm != null
      && reading.voltageV != null
      && inRange(reading.irMohm, reading.voltageV, currentLimits);

    if (!irOk) {
      resetStability();
      return;
    }

    const sample = { irMohm: reading.irMohm!, voltageV: reading.voltageV! };
    const samples = holdSamplesRef.current;

    if (samples.length > 0) {
      const anchor = median(samples.map((entry) => entry.irMohm));
      if (Math.abs(sample.irMohm - anchor) > IR_HOLD_DRIFT_MOHM) {
        holdSamplesRef.current = [sample];
        holdStartedAtRef.current = Date.now();
        setIsStable(false);
        setStableProgress(0);
        return;
      }
    }

    if (holdStartedAtRef.current == null) {
      holdStartedAtRef.current = Date.now();
    }
    samples.push(sample);
    // Keep the hold window light; time decides readiness, not sample count.
    if (samples.length > 40) {
      samples.shift();
    }
    updateHoldProgress();
  }, [reading, resetStability, resetClearHold, updateHoldProgress, updateClearProgress]);

  const handleStart = async () => {
    setError(null);
    setBusy(true);
    try {
      const from = Math.max(1, Math.floor(Number(startFromInput) || 1));
      setCellId(from);
      const next = await fetchNextIrCell(from);
      setPendingCount(next.pendingCount);
      // Start at the requested cell even if it already has IR (override / remeasure).
      setPhase("measuring");
      setStatusMessage(`Insert cell #${from}`);
      resetStability();
      await refreshMeasurements();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
      setPhase("idle");
    } finally {
      setBusy(false);
    }
  };

  const handleStop = () => {
    setPhase("idle");
    setStatusMessage(null);
    resetStability();
    resetClearHold();
    void refreshNextDefault();
  };

  const handleJump = () => {
    const next = Math.max(1, Math.floor(Number(startFromInput) || 1));
    setCellId(next);
    setPhase("measuring");
    setStatusMessage(`Insert cell #${next}`);
    resetStability();
  };

  const handleManualSave = async () => {
    const irMohm = Number(manualIr);
    const voltageV = Number(manualVoltage || reading?.voltageV);
    if (!Number.isFinite(irMohm) || !Number.isFinite(voltageV)) {
      setError("Enter a valid IR (and voltage if the meter has none)");
      return;
    }
    await persistReading({
      irMohm,
      voltageV,
      source: "manual",
      skipValidation: true,
    });
    setManualIr("");
  };

  const handleSkip = async () => {
    setStatusMessage(`Skipped cell #${cellIdRef.current}`);
    await advanceToNextCell();
  };

  const rangeChecks = useMemo(() => {
    const ir = reading?.irMohm;
    const v = reading?.voltageV;
    return {
      irOk: ir != null && ir >= limits.irMinMohm && ir <= limits.irMaxMohm,
      voltageOk: v != null && v >= limits.voltageMinV && v <= limits.voltageMaxV,
      stableOk: isStable,
      stablePercent: Math.round(stableProgress * 100),
      clearPercent: Math.round(clearProgress * 100),
    };
  }, [reading, limits, isStable, stableProgress, clearProgress]);

  const meterAgeSec = reading ? Math.max(0, Math.round((Date.now() - reading.receivedAtMs) / 1000)) : null;

  return (
    <div className="min-h-full bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/90">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6">
          <div>
            <h1 className="text-2xl font-semibold text-white">IR Test Station</h1>
            <p className="text-sm text-slate-400">
              YR1035 → Hub {getApiBaseUrl()} · pending without IR: {pendingCount}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => {
                unlockAudio();
                void playSuccessSound();
              }}
              className="rounded-lg border border-emerald-400/50 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-100 hover:border-emerald-300 hover:bg-emerald-500/20"
            >
              Test sound
            </button>
            <Link
              href="/"
              className="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:bg-slate-800"
            >
              Dashboard
            </Link>
            <Link
              href="/history"
              className="rounded-lg border border-blue-400/50 bg-blue-500/10 px-4 py-2 text-sm font-semibold text-blue-100 hover:border-blue-300 hover:bg-blue-500/20"
            >
              Cell Analytics
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        {error ? (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {error}
          </div>
        ) : null}

        <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-2xl shadow-slate-950/30">
          <div className="flex flex-wrap items-end gap-4">
            <label className="block">
              <span className="text-xs uppercase tracking-[0.2em] text-slate-500">Start from cell</span>
              <input
                type="number"
                min={1}
                value={startFromInput}
                onChange={(e) => setStartFromInput(e.target.value)}
                disabled={phase === "measuring" || phase === "waiting_clear"}
                className="mt-1 block w-36 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-lg text-white"
              />
            </label>
            {phase === "idle" || phase === "complete" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleStart()}
                className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
              >
                Start
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleJump}
                  className="rounded-lg border border-amber-400/50 bg-amber-500/10 px-4 py-2.5 text-sm font-semibold text-amber-100 hover:bg-amber-500/20"
                >
                  Jump to cell
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSkip()}
                  className="rounded-lg border border-slate-600 px-4 py-2.5 text-sm hover:bg-slate-800 disabled:opacity-40"
                >
                  Skip
                </button>
                <button
                  type="button"
                  onClick={handleStop}
                  className="rounded-lg border border-rose-400/50 bg-rose-500/10 px-4 py-2.5 text-sm font-semibold text-rose-100 hover:bg-rose-500/20"
                >
                  Stop
                </button>
              </>
            )}
            <p className="ml-auto text-sm text-slate-400">
              Meter {meterConnected ? "live" : "waiting"}
              {meterAgeSec != null ? ` · last frame ${meterAgeSec}s ago` : ""}
            </p>
          </div>
        </section>

        <section className="grid gap-6 md:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-8 text-center shadow-2xl shadow-slate-950/30">
            <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
              {phase === "idle"
                ? "Ready"
                : phase === "waiting_clear"
                  ? "Remove cell"
                  : phase === "complete"
                    ? "Done"
                    : "Insert cell"}
            </p>
            <p className="mt-3 text-7xl font-semibold tabular-nums text-white">#{cellId}</p>
            <p className="mt-4 text-sm text-slate-300">
              {statusMessage
                ?? (phase === "idle"
                  ? "Press Start, then probe cells in order."
                  : "Waiting for a stable in-range reading…")}
            </p>
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-2xl shadow-slate-950/30">
            <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Live meter</p>
            <div className="mt-4 space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-400">IR</span>
                <span className="text-3xl font-semibold tabular-nums text-white">
                  {reading?.irMohm != null ? `${reading.irMohm.toFixed(2)} mΩ` : (reading?.resistanceDisplay ?? "—")}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-slate-400">Voltage</span>
                <span className="text-3xl font-semibold tabular-nums text-white">
                  {reading?.voltageV != null ? `${reading.voltageV.toFixed(4)} V` : "—"}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-slate-400">Status</span>
                <span className="font-medium text-slate-200">{reading?.status ?? "no data"}</span>
              </div>
            </div>

            <ul className="mt-6 space-y-2 text-sm">
              <li className={rangeChecks.irOk ? "text-emerald-300" : "text-slate-400"}>
                {rangeChecks.irOk ? "✓" : "○"} IR {limits.irMinMohm}–{limits.irMaxMohm} mΩ
              </li>
              <li className={rangeChecks.voltageOk ? "text-emerald-300" : "text-slate-400"}>
                {rangeChecks.voltageOk ? "✓" : "○"} Voltage {limits.voltageMinV}–{limits.voltageMaxV} V
              </li>
              <li className={rangeChecks.stableOk ? "text-emerald-300" : "text-slate-400"}>
                {rangeChecks.stableOk ? "✓" : "○"} Stable hold {rangeChecks.stablePercent}%
                {" "}({(STABLE_HOLD_MS / 1000).toFixed(1)}s in range, drift ≤ {IR_HOLD_DRIFT_MOHM} mΩ)
              </li>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full rounded-full bg-emerald-400 transition-[width] duration-75"
                  style={{ width: `${rangeChecks.stablePercent}%` }}
                />
              </div>
              {phase === "waiting_clear" ? (
                <>
                  <li className="mt-3 text-amber-200">
                    Remove hold {rangeChecks.clearPercent}% ({CLEAR_HOLD_MS / 1000}s of OL)
                  </li>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-amber-400 transition-[width] duration-75"
                      style={{ width: `${rangeChecks.clearPercent}%` }}
                    />
                  </div>
                </>
              ) : null}
            </ul>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-2xl shadow-slate-950/30">
          <h2 className="text-lg font-semibold text-white">Manual IR entry</h2>
          <p className="mt-1 text-sm text-slate-400">
            Override for cell #{cellId}. Skips range checks. Uses live voltage if voltage field is empty.
          </p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="text-xs text-slate-500">IR (mΩ)</span>
              <input
                type="number"
                step="0.01"
                value={manualIr}
                onChange={(e) => setManualIr(e.target.value)}
                className="mt-1 block w-32 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Voltage (V)</span>
              <input
                type="number"
                step="0.001"
                placeholder={reading?.voltageV != null ? reading.voltageV.toFixed(4) : "3.25"}
                value={manualVoltage}
                onChange={(e) => setManualVoltage(e.target.value)}
                className="mt-1 block w-36 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
              />
            </label>
            <button
              type="button"
              disabled={busy || phase === "idle"}
              onClick={() => void handleManualSave()}
              className="rounded-lg border border-violet-400/50 bg-violet-500/10 px-4 py-2 text-sm font-semibold text-violet-100 hover:bg-violet-500/20 disabled:opacity-40"
            >
              Save manual
            </button>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-2xl shadow-slate-950/30">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-white">Stored IR</h2>
            <button
              type="button"
              onClick={() => void refreshMeasurements().catch(() => undefined)}
              className="text-sm text-slate-400 hover:text-white"
            >
              Refresh
            </button>
          </div>
          {measurements.length === 0 ? (
            <p className="text-sm text-slate-500">No IR measurements yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="pb-2 pr-4">Cell</th>
                    <th className="pb-2 pr-4">IR</th>
                    <th className="pb-2 pr-4">Voltage</th>
                    <th className="pb-2 pr-4">Source</th>
                    <th className="pb-2">Measured</th>
                  </tr>
                </thead>
                <tbody>
                  {[...measurements].reverse().map((row) => (
                    <tr key={row.cellId} className="border-t border-slate-800">
                      <td className="py-2 pr-4 font-medium text-white">#{row.cellId}</td>
                      <td className="py-2 pr-4 tabular-nums">{row.irMohm.toFixed(2)} mΩ</td>
                      <td className="py-2 pr-4 tabular-nums">{row.voltageV.toFixed(4)} V</td>
                      <td className="py-2 pr-4 text-slate-400">{row.source}</td>
                      <td className="py-2 text-slate-400">{formatTime(row.measuredAtMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
