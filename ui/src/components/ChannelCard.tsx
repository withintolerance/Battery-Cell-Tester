"use client";

import type { ChannelStatus, LimitsInfo, AutomationStatus, InaStatus, ThermistorStatus } from "@/lib/types";
import { setCharge, setDischarge, setIchg, startAutomation, stopAutomation } from "@/lib/api";
import { useEffect, useState } from "react";

interface ChannelCardProps {
  ip: string;
  channel: ChannelStatus;
  auto: AutomationStatus;
  ina: InaStatus;
  thermistor: ThermistorStatus;
  limits: LimitsInfo;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string) => void;
  passThresholdMah: number;
}

function formatMv(mv: number): string {
  return `${(mv / 1000).toFixed(3)} V`;
}

function formatDuration(ms: number): string {
  if (ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function ChannelCard({
  ip,
  channel,
  auto,
  ina,
  thermistor,
  limits,
  busy,
  onBusy,
  onError,
  passThresholdMah,
}: ChannelCardProps) {
  const [ichgInput, setIchgInput] = useState(String(channel.ichgLimitMa));
  const [dutyInput, setDutyInput] = useState(String(channel.dischargeDuty));
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- board telemetry is the external source for these form defaults */
    setIchgInput(String(channel.ichgLimitMa));
    setDutyInput(String(channel.dischargeDuty));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [channel.ichgLimitMa, channel.dischargeDuty]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    onBusy(true);
    try {
      await action();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Command failed");
    } finally {
      onBusy(false);
    }
  };

  const chargeBlockedReason = !channel.cellPresent
    ? `No cell detected`
    : channel.dischargeDuty > 0
      ? "Discharge PWM is active"
      : null;

  const dischargeBlockedReason = !channel.cellPresent
    ? `No cell detected`
    : channel.chargeEnabled
      ? "Charging is enabled"
      : null;

  const isComplete = auto?.state === "COMPLETE";
  const isFault = auto?.state === "FAULT";
  const isAutoActive = auto?.state !== "IDLE" && auto?.state !== undefined;
  const isRunning = isAutoActive && !isComplete && !isFault;
  const isFinished = isComplete || isFault;
  const cellId = auto?.cellId ?? 0;
  const passed = auto?.capacityMah >= passThresholdMah;

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900/80 p-5 shadow-lg">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">
            {channel.label} (CH{channel.channel})
          </h2>
          <p className="text-sm text-slate-400">
            {channel.cellPresent ? "Cell detected" : "No / low cell"}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              isFault
                ? "bg-rose-500/20 text-rose-300"
                : isComplete
                  ? passed ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"
                  : isAutoActive
                    ? "bg-blue-500/20 text-blue-300"
                    : channel.chargeEnabled
                      ? "bg-amber-500/20 text-amber-300"
                      : channel.dischargeDuty > 0
                        ? "bg-rose-500/20 text-rose-300"
                        : "bg-slate-500/20 text-slate-300"
            }`}
          >
            {isFault
              ? `FAULT: ${auto?.faultReason}`
              : isComplete
                ? passed ? "PASS" : "FAIL"
                : isAutoActive
                  ? `AUTO: ${auto?.state}`
                  : channel.chargeEnabled
                    ? "Charging allowed"
                    : channel.dischargeDuty > 0
                      ? "Discharging"
                      : "Idle"}
          </span>
          {isAutoActive && auto?.state !== "COMPLETE" && auto?.state !== "FAULT" && now !== null && auto?.serverStateStartMs && (
            <span className="text-xs font-mono text-blue-300">
              {formatDuration(now - auto.serverStateStartMs)}
            </span>
          )}
          {isAutoActive && (
            <span className="text-xs font-mono text-slate-400">
              Cell-{auto?.cellId?.toString().padStart(3, '0')}
            </span>
          )}
        </div>
      </div>

      <dl className="mb-5 grid grid-cols-2 gap-3 text-sm">
        <div className="col-span-2">
          <dt className="text-slate-400">Cell voltage</dt>
          <dd className="font-mono text-white flex gap-4">
            <span>{ina?.valid ? formatMv(ina.busVolts * 1000) : "—"} <span className="text-slate-500 text-xs">INA</span></span>
            <span>|</span>
            <span>{channel.valid ? formatMv(channel.vbatMv) : "—"} <span className="text-slate-500 text-xs">BQ</span></span>
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Current (INA)</dt>
          <dd className="font-mono text-white">
            {ina?.valid ? `${(ina.currentAmps * 1000).toFixed(0)} mA` : "—"}
          </dd>
        </div>
        {auto && (
          <>
            <div>
              <dt className="text-slate-400">Capacity</dt>
              <dd className="font-mono text-white">{auto.capacityMah.toFixed(1)} mAh</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-slate-400">Automation Voltages</dt>
              <dd className="font-mono text-white flex gap-4">
                <span>Rest: {auto.restingVoltageMv} mV</span>
                <span>|</span>
                <span>Sag (5m): {auto.activeVoltageMv > 0 ? `${auto.activeVoltageMv} mV` : "—"}</span>
              </dd>
            </div>
          </>
        )}
        <div>
          <dt className="text-slate-400">Cell Temp</dt>
          <dd className="font-mono text-white">
            {thermistor?.valid ? `${thermistor.temperatureC.toFixed(1)} °C` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Charger Temp (Die)</dt>
          <dd className="font-mono text-white">{channel.tdieApproxC} °C</dd>
        </div>
        <div>
          <dt className="text-slate-400">ICHG limit</dt>
          <dd className="font-mono text-white">{channel.ichgLimitMa} mA</dd>
        </div>
        <div>
          <dt className="text-slate-400">Discharge PWM</dt>
          <dd className="font-mono text-white">{channel.dischargeDuty} / 255</dd>
        </div>
        <div>
          <dt className="text-slate-400">Charge status</dt>
          <dd className="text-white">{channel.chgStatus}</dd>
        </div>
        <div>
          <dt className="text-slate-400">IBAT</dt>
          <dd className="font-mono text-white">{channel.ibatMa} mA</dd>
        </div>
        <div>
          <dt className="text-slate-400">VSYS</dt>
          <dd className="font-mono text-white">{formatMv(channel.vsysMv)}</dd>
        </div>
        <div>
          <dt className="text-slate-400">VBUS</dt>
          <dd className="font-mono text-white">{formatMv(channel.vbusMv)}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Fault</dt>
          <dd className="font-mono text-white">
            0x{channel.fault0.toString(16)}
            {channel.fault0 === 0x06 && <span className="ml-2 text-xs text-slate-500">(No fault)</span>}
          </dd>
        </div>
      </dl>

      <div className="space-y-4 border-t border-slate-800 pt-4">
        {isRunning ? (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => stopAutomation({ boardIp: ip, channel: channel.channel as 1 | 2 }))}
              className="w-full rounded-lg bg-rose-700 px-4 py-3 text-sm font-semibold text-white hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              STOP AUTOMATION
            </button>
          </div>
        ) : isFinished ? (
          <div className="flex flex-col gap-2">
            <p className="text-center text-sm font-medium text-slate-300">
              {isComplete
                ? "Test complete — ready to swap in the next cell."
                : "Test faulted — reset the bay or try again."}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => stopAutomation({ boardIp: ip, channel: channel.channel as 1 | 2 }))}
                className="w-full rounded-lg bg-emerald-600 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isComplete ? "Reset for next cell" : "Reset bay"}
              </button>
              <button
                type="button"
                disabled={busy || cellId <= 0}
                onClick={() =>
                  run(() =>
                    startAutomation({ boardIp: ip, channel: channel.channel as 1 | 2, mode: "retest", cellId }),
                  )
                }
                className="w-full rounded-lg border border-slate-600 bg-slate-900/70 px-4 py-3 text-sm font-semibold text-slate-200 hover:border-sky-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                Test again (Cell-{cellId.toString().padStart(3, "0")})
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={busy || !channel.cellPresent}
              onClick={() => run(() => startAutomation({ boardIp: ip, channel: channel.channel as 1 | 2, mode: "new" }))}
              className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              START AUTO CYCLE
            </button>
            {!channel.cellPresent && (
              <p className="text-center text-xs text-slate-400">Insert a cell to start</p>
            )}
          </div>
        )}
        {!isAutoActive && (
          <details className="group">
            <summary className="cursor-pointer text-sm text-slate-400 hover:text-slate-300">
              Manual Controls
            </summary>
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy || !!chargeBlockedReason}
                  onClick={() =>
                    run(() => setCharge(ip, channel.channel as 1 | 2, true))
                  }
                  className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Charge ON
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(() => setCharge(ip, channel.channel as 1 | 2, false))
                  }
                  className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Charge OFF
                </button>
              </div>
              {chargeBlockedReason ? (
                <p className="text-xs text-amber-300">{chargeBlockedReason}</p>
              ) : null}

              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-400">
                    ICHG (mA, {limits.ichgStepMa} mA steps, max {limits.ichgMaxMa})
                  </span>
                  <input
                    type="number"
                    min={limits.ichgMinMa}
                    max={limits.ichgMaxMa}
                    step={limits.ichgStepMa}
                    value={ichgInput}
                    onChange={(e) => setIchgInput(e.target.value)}
                    className="w-36 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-white"
                  />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      setIchg(ip, channel.channel as 1 | 2, Number(ichgInput)),
                    )
                  }
                  className="rounded-lg bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Set ICHG
                </button>
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-400">Discharge duty (0-255)</span>
                  <input
                    type="number"
                    min={0}
                    max={255}
                    value={dutyInput}
                    onChange={(e) => setDutyInput(e.target.value)}
                    className="w-36 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-white"
                  />
                </label>
                <button
                  type="button"
                  disabled={busy || (!!dischargeBlockedReason && Number(dutyInput) > 0)}
                  onClick={() =>
                    run(() =>
                      setDischarge(ip, channel.channel as 1 | 2, Number(dutyInput)),
                    )
                  }
                  className="rounded-lg bg-rose-700 px-4 py-2 text-sm font-medium text-white hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Set discharge
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDutyInput("0");
                    void run(() => setDischarge(ip, channel.channel as 1 | 2, 0));
                  }}
                  className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Discharge OFF
                </button>
              </div>
              {dischargeBlockedReason && Number(dutyInput) > 0 ? (
                <p className="text-xs text-rose-300">{dischargeBlockedReason}</p>
              ) : null}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}
