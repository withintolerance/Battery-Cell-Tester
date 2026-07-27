"use client";

import {
  CELL_SLOTS,
  cellExtremeKey,
  type FleetExtremes,
} from "@/lib/fleet-extremes";
import type { RangeAlertHighlights } from "@/lib/range-alerts";
import type {
  AutomationStatus,
  ChannelStatus,
  CrashSummary,
  InaStatus,
  StatusResponse,
  ThermistorStatus,
} from "@/lib/types";

interface BoardOverviewProps {
  ip: string;
  status: StatusResponse | undefined;
  crash?: CrashSummary;
  passThresholdMah: number;
  isExpanded: boolean;
  busy: boolean;
  extremes: FleetExtremes;
  rangeHighlights: RangeAlertHighlights;
  onToggleExpanded: () => void;
  onStartAuto: (channel: 1 | 2) => void;
  onStopAuto: (channel: 1 | 2) => void;
  onRetest: (channel: 1 | 2, cellId: number) => void;
}

function formatDurationMs(durationMs?: number | null): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    return "—";
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatMv(mv: number): string {
  return `${(mv / 1000).toFixed(3)} V`;
}

function getBayStatus(
  auto: AutomationStatus | undefined,
  channel: ChannelStatus | undefined,
  passThresholdMah: number,
): { label: string; tone: "idle" | "auto" | "charge" | "discharge" | "pass" | "fail" | "fault" | "empty" } {
  if (!channel?.cellPresent) {
    return { label: "Empty", tone: "empty" };
  }
  if (auto?.state === "FAULT") {
    return {
      label: auto.faultReason ? `Fault: ${auto.faultReason}` : "Fault",
      tone: "fault",
    };
  }
  if (auto?.state === "COMPLETE") {
    const passed = (auto.capacityMah ?? 0) >= passThresholdMah;
    return { label: passed ? "Pass" : "Fail", tone: passed ? "pass" : "fail" };
  }
  if (auto?.state && auto.state !== "IDLE") {
    return { label: auto.state.replaceAll("_", " "), tone: "auto" };
  }
  if (channel.chargeEnabled) {
    return { label: "Charging", tone: "charge" };
  }
  if (channel.dischargeDuty > 0) {
    return { label: "Discharging", tone: "discharge" };
  }
  return { label: "Idle", tone: "idle" };
}

const statusToneClass: Record<
  ReturnType<typeof getBayStatus>["tone"],
  string
> = {
  idle: "border-slate-500/35 bg-slate-500/15 text-slate-200",
  auto: "border-sky-400/40 bg-sky-500/15 text-sky-200",
  charge: "border-amber-400/40 bg-amber-500/15 text-amber-100",
  discharge: "border-rose-400/40 bg-rose-500/15 text-rose-100",
  pass: "border-emerald-400/45 bg-emerald-500/15 text-emerald-200",
  fail: "border-rose-400/45 bg-rose-500/15 text-rose-100",
  fault: "border-rose-400/55 bg-rose-500/20 text-rose-100",
  empty: "border-slate-600/40 bg-slate-800/60 text-slate-400",
};

function CellBay({
  ip,
  channel,
  auto,
  ina,
  thermistor,
  passThresholdMah,
  busy,
  online,
  highlightLowestVoltage,
  highlightHighestCellTemp,
  voltageOutOfRange,
  tempOutOfRange,
  onStartAuto,
  onStopAuto,
  onRetest,
}: {
  ip: string;
  channel: ChannelStatus | undefined;
  auto: AutomationStatus | undefined;
  ina: InaStatus | undefined;
  thermistor: ThermistorStatus | undefined;
  passThresholdMah: number;
  busy: boolean;
  online: boolean;
  highlightLowestVoltage: boolean;
  highlightHighestCellTemp: boolean;
  voltageOutOfRange: boolean;
  tempOutOfRange: boolean;
  onStartAuto: (channel: 1 | 2) => void;
  onStopAuto: (channel: 1 | 2) => void;
  onRetest: (channel: 1 | 2, cellId: number) => void;
}) {
  const present = Boolean(channel?.cellPresent);
  const status = getBayStatus(auto, channel, passThresholdMah);
  const isDischarging =
    Boolean(channel && channel.dischargeDuty > 0) || auto?.state === "DISCHARGE";
  const isCharging =
    Boolean(channel?.chargeEnabled) ||
    auto?.state === "CHARGE_INITIAL" ||
    auto?.state === "CHARGE_STORAGE";
  const autoState = auto?.state ?? "IDLE";
  const isComplete = autoState === "COMPLETE";
  const isFault = autoState === "FAULT";
  const isRunning = autoState !== "IDLE" && !isComplete && !isFault;
  const isFinished = isComplete || isFault;
  const cellId = auto?.cellId ?? 0;
  const channelNum = (channel?.channel ?? 1) as 1 | 2;
  const startBlockedReason = !online
    ? "Board offline"
    : !present
      ? "No cell detected"
      : null;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2.5">
      <div
        className={`relative overflow-hidden rounded-[1.35rem] border px-2.5 pb-3 pt-3 transition-all duration-300 ${
          present
            ? "border-lime-400/35 bg-gradient-to-b from-lime-400 via-lime-500 to-lime-700 shadow-[0_10px_28px_rgba(101,163,13,0.28)]"
            : "border-slate-700/70 bg-gradient-to-b from-slate-600 via-slate-700 to-slate-900 opacity-55 grayscale"
        }`}
      >
        <div
          className={`pointer-events-none absolute inset-x-3 top-2 h-2 rounded-full ${
            present ? "bg-lime-200/70" : "bg-slate-400/40"
          }`}
        />
        <div
          className={`pointer-events-none absolute inset-y-5 left-1 w-1 rounded-full ${
            present ? "bg-white/25" : "bg-white/10"
          }`}
        />

        <div className="relative z-10 space-y-2">
          <div>
            <div>
              <p className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${present ? "text-lime-950" : "text-slate-300"}`}>
                {channel?.label ?? `CH${channelNum}`}
              </p>
              <p className={`font-mono text-[10px] ${present ? "text-lime-950/70" : "text-slate-400"}`}>
                CH{channelNum}
                {auto?.cellId ? ` · Cell-${auto.cellId.toString().padStart(3, "0")}` : ""}
              </p>
            </div>
            <span
              className={`mt-1.5 block w-full rounded-md border px-2 py-1 text-center text-[10px] font-semibold capitalize leading-tight ${statusToneClass[status.tone]}`}
              title={status.label}
            >
              {status.label}
            </span>
          </div>

          <dl className={`grid gap-1.5 rounded-xl px-2 py-2 text-[11px] backdrop-blur-sm ${
            present ? "bg-black/35 text-lime-50" : "bg-black/45 text-slate-300"
          }`}>
            <Metric
              label="Voltage"
              value={ina?.valid ? formatMv(ina.busVolts * 1000) : "—"}
              highlight={voltageOutOfRange || highlightLowestVoltage}
              title={
                voltageOutOfRange
                  ? "Cell voltage is outside the chemistry safe window"
                  : highlightLowestVoltage
                    ? "Lowest Kelvin-sensed cell voltage across all boards"
                    : undefined
              }
            />
            {isDischarging ? (
              <Metric
                label="Current"
                value={ina?.valid ? `${Math.abs(ina.currentAmps * 1000).toFixed(0)} mA` : "—"}
              />
            ) : null}
            {isCharging ? (
              <Metric
                label="IBAT"
                value={channel ? `${channel.ibatMa} mA` : "—"}
              />
            ) : null}
            <Metric
              label="Temp"
              value={
                thermistor?.valid
                  ? `${thermistor.temperatureC.toFixed(1)} °C`
                  : tempOutOfRange
                    ? "Invalid"
                    : "—"
              }
              highlight={tempOutOfRange || highlightHighestCellTemp}
              title={
                tempOutOfRange
                  ? "Cell temperature is out of range (15–38 °C) or sensor invalid"
                  : highlightHighestCellTemp
                    ? "Highest cell temperature across all boards"
                    : undefined
              }
            />
            <Metric
              label="Capacity"
              value={auto ? `${auto.capacityMah.toFixed(1)} mAh` : "—"}
            />
            {isCharging ? (
              <Metric
                label="Charger"
                value={channel ? `${channel.tdieApproxC} °C` : "—"}
              />
            ) : null}
          </dl>
        </div>
      </div>

      {isRunning ? (
        <button
          type="button"
          disabled={busy || !online}
          onClick={() => onStopAuto(channelNum)}
          className="rounded-lg bg-rose-700 px-3 py-2 text-xs font-semibold text-white shadow-lg shadow-rose-950/30 transition hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`Stop automation on board ${ip} channel ${channelNum}`}
        >
          Stop auto
        </button>
      ) : isFinished ? (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            disabled={busy || !online}
            onClick={() => onStopAuto(channelNum)}
            className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-lg shadow-emerald-950/30 transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={`Reset bay on board ${ip} channel ${channelNum} for the next cell`}
          >
            {isComplete ? "Done · reset for next cell" : "Reset bay"}
          </button>
          <button
            type="button"
            disabled={busy || !online || cellId <= 0}
            onClick={() => onRetest(channelNum, cellId)}
            className="rounded-lg border border-slate-600 bg-slate-900/70 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-sky-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={`Run the test again on board ${ip} channel ${channelNum}`}
          >
            Test again
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy || Boolean(startBlockedReason)}
          onClick={() => onStartAuto(channelNum)}
          title={startBlockedReason ?? undefined}
          className="rounded-lg bg-sky-600 px-3 py-2 text-xs font-semibold text-white shadow-lg shadow-sky-950/30 transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`Start automation on board ${ip} channel ${channelNum}`}
        >
          Start auto
        </button>
      )}
      {startBlockedReason && !isRunning && !isFinished ? (
        <p className="text-center text-[10px] text-slate-500">{startBlockedReason}</p>
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
  highlight = false,
  title,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2" title={title}>
      <dt
        className={`shrink-0 text-[9px] uppercase tracking-wide ${
          highlight ? "font-bold text-rose-300" : "text-white/55"
        }`}
      >
        {label}
      </dt>
      <dd
        className={`truncate font-mono text-[11px] tabular-nums ${
          highlight
            ? "font-bold text-rose-300 drop-shadow-[0_0_6px_rgba(251,113,133,0.55)]"
            : "font-medium"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

export function BoardOverview({
  ip,
  status,
  crash,
  passThresholdMah,
  isExpanded,
  busy,
  extremes,
  rangeHighlights,
  onToggleExpanded,
  onStartAuto,
  onStopAuto,
  onRetest,
}: BoardOverviewProps) {
  const online = Boolean(status?.online);
  const heatsink = status?.thermistors?.[1];
  const fanOn = Boolean(status?.system?.fanOn);
  const chemistryLabel =
    status?.chemistry?.id === "lifepo4"
      ? "LiFePO4"
      : status?.chemistry?.id === "nmc_18650"
        ? "NMC 18650"
        : status?.chemistry?.label ?? "—";
  const shortIp = ip.split(".").slice(-1)[0] ?? ip;
  const hasCrash = Boolean(crash && crash.unresolvedCrashes > 0);
  const highlightHighestHeatsink = extremes.highestHeatsinkKeys.has(ip);
  const heatsinkOutOfRange = rangeHighlights.heatsinkKeys.has(ip);

  return (
    <div className="flex h-full flex-col">
      {/* Heatsink / board system strip */}
      <div
        className="relative overflow-hidden rounded-t-2xl border-b border-slate-500/40 px-3 pb-2.5 pt-2.5"
        style={{
          background:
            "linear-gradient(180deg, #c5cdd8 0%, #8f9aab 38%, #6b7687 72%, #4e5868 100%)",
        }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-45"
          style={{
            backgroundImage:
              "repeating-linear-gradient(90deg, transparent 0 7px, rgba(255,255,255,0.16) 7px 8px, transparent 8px 14px)",
          }}
        />
        <div className="relative z-10 space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    online
                      ? "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.7)]"
                      : "bg-rose-500"
                  }`}
                />
                <h2 className="truncate text-sm font-bold tracking-wide text-slate-950">
                  Board #{shortIp}
                </h2>
              </div>
              <p className="mt-0.5 font-mono text-[10px] text-slate-800/80">{ip}</p>
            </div>
            <button
              type="button"
              aria-expanded={isExpanded}
              aria-controls={`board-details-${ip.replaceAll(".", "-")}`}
              onClick={onToggleExpanded}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-700/30 bg-slate-950/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-950 backdrop-blur-sm transition hover:bg-slate-950/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              {isExpanded ? "Collapse" : "Expand"}
              <svg
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
                className={`h-3.5 w-3.5 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
              >
                <path
                  d="m5 7.5 5 5 5-5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>

          {hasCrash ? (
            <div className="rounded-md border border-rose-700/40 bg-rose-600/25 px-2 py-1 text-[10px] font-semibold text-rose-950">
              {crash!.unresolvedCrashes} unresolved crash
              {crash!.unresolvedCrashes === 1 ? "" : "es"}
            </div>
          ) : null}

          <dl className="grid grid-cols-2 gap-1.5">
            <HeatsinkMetric
              label="Heatsink"
              value={heatsink?.valid ? `${heatsink.temperatureC.toFixed(1)} °C` : "—"}
              highlight={heatsinkOutOfRange || highlightHighestHeatsink}
              title={
                heatsinkOutOfRange
                  ? "Heatsink temperature is out of range (15–50 °C)"
                  : highlightHighestHeatsink
                    ? "Highest heatsink temperature across all boards"
                    : undefined
              }
            />
            <HeatsinkMetric label="Fan" value={online ? (fanOn ? "ON" : "OFF") : "—"} />
            <HeatsinkMetric
              label="Uptime"
              value={online ? formatDurationMs(status?.system?.uptimeMs) : "—"}
            />
            <HeatsinkMetric label="Chemistry" value={chemistryLabel} />
          </dl>
        </div>
      </div>

      {/* Cell bays */}
      <div className="flex flex-1 gap-2 bg-gradient-to-b from-slate-900 via-slate-950 to-black px-2 py-2.5">
        {status?.channels && status.automation ? (
          CELL_SLOTS.map(({ channelIndex, thermistorIndex }) => {
            const channel = status.channels[channelIndex];
            const channelNum = channel?.channel ?? channelIndex + 1;
            const cellKey = cellExtremeKey(ip, channelNum);
            return (
              <CellBay
                key={`${ip}-${channelIndex}`}
                ip={ip}
                channel={channel}
                auto={status.automation[channelIndex]}
                ina={status.ina?.[channelIndex]}
                thermistor={status.thermistors?.[thermistorIndex]}
                passThresholdMah={passThresholdMah}
                busy={busy}
                online={online}
                highlightLowestVoltage={extremes.lowestVoltageKeys.has(cellKey)}
                highlightHighestCellTemp={extremes.highestCellTempKeys.has(cellKey)}
                voltageOutOfRange={rangeHighlights.voltageKeys.has(cellKey)}
                tempOutOfRange={rangeHighlights.cellTempKeys.has(cellKey)}
                onStartAuto={onStartAuto}
                onStopAuto={onStopAuto}
                onRetest={onRetest}
              />
            );
          })
        ) : (
          <div className="flex min-h-48 flex-1 items-center justify-center rounded-xl border border-dashed border-slate-700 px-3 text-center text-xs text-slate-500">
            {online ? "Waiting for telemetry…" : "Board offline or initializing"}
          </div>
        )}
      </div>
    </div>
  );
}

function HeatsinkMetric({
  label,
  value,
  highlight = false,
  title,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  title?: string;
}) {
  return (
    <div
      className={`rounded-md px-2 py-1.5 backdrop-blur-[2px] ${
        highlight ? "bg-rose-700/25 ring-1 ring-rose-700/35" : "bg-slate-950/20"
      }`}
      title={title}
    >
      <dt
        className={`text-[9px] font-semibold uppercase tracking-[0.12em] ${
          highlight ? "text-rose-900" : "text-slate-800/75"
        }`}
      >
        {label}
      </dt>
      <dd
        className={`mt-0.5 truncate font-mono text-xs tabular-nums ${
          highlight ? "font-bold text-rose-950" : "font-semibold text-slate-950"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
