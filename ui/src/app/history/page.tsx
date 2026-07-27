"use client";

import Link from "next/link";
import { fetchRun, fetchRuns, getApiBaseUrl } from "@/lib/api";
import type { CellLog, CellRunSummary } from "@/lib/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const PAGE_SIZE = 50;

const stateStyles: Record<string, { label: string; className: string; color: string }> = {
  CHARGE_INITIAL: {
    label: "Initial charge",
    className: "bg-amber-400/15 text-amber-200 ring-amber-300/20",
    color: "#f59e0b",
  },
  REST: {
    label: "Rest",
    className: "bg-sky-400/15 text-sky-200 ring-sky-300/20",
    color: "#38bdf8",
  },
  DISCHARGE: {
    label: "Discharge",
    className: "bg-rose-400/15 text-rose-200 ring-rose-300/20",
    color: "#fb7185",
  },
  CHARGE_STORAGE: {
    label: "Storage charge",
    className: "bg-emerald-400/15 text-emerald-200 ring-emerald-300/20",
    color: "#34d399",
  },
  COMPLETE: {
    label: "Complete",
    className: "bg-violet-400/15 text-violet-200 ring-violet-300/20",
    color: "#a78bfa",
  },
  FAULT: {
    label: "Fault",
    className: "bg-red-500/15 text-red-200 ring-red-300/20",
    color: "#ef4444",
  },
};

const fallbackStateStyle = {
  label: "Unknown",
  className: "bg-slate-500/15 text-slate-300 ring-slate-400/20",
  color: "#94a3b8",
};

function stateStyle(state: string) {
  return stateStyles[state] ?? { ...fallbackStateStyle, label: state };
}

function runStatusBadge(run: CellRunSummary): { label: string; className: string } {
  switch (run.status) {
    case "complete":
      return run.passed
        ? { label: "Pass", className: "bg-emerald-400/15 text-emerald-200 ring-emerald-300/20" }
        : { label: "Fail", className: "bg-rose-400/15 text-rose-200 ring-rose-300/20" };
    case "running":
      return { label: "In progress", className: "bg-blue-400/15 text-blue-200 ring-blue-300/20" };
    case "fault":
      return { label: "Fault", className: "bg-red-500/15 text-red-200 ring-red-300/20" };
    case "stopped":
      return { label: "Stopped", className: "bg-slate-500/15 text-slate-300 ring-slate-400/20" };
    case "start_failed":
      return { label: "Start failed", className: "bg-amber-500/15 text-amber-200 ring-amber-300/20" };
    default:
      return { label: run.status, className: fallbackStateStyle.className };
  }
}

function parseMs(timestamp: string | null | undefined): number | null {
  if (!timestamp) {
    return null;
  }
  const normalized = timestamp.includes("T") ? timestamp : timestamp.replace(" ", "T");
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = Date.parse(withZone);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTimestamp(timestamp: string | null | undefined): string {
  const ms = parseMs(timestamp);
  if (ms === null) {
    return timestamp ?? "—";
  }
  return new Date(ms).toLocaleString();
}

function formatDurationMs(durationMs?: number | null): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return "—";
  }
  const totalSeconds = Math.round(durationMs / 1000);
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

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0:00";
  }
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function metricText(value: number | null | undefined, unit: string, digits = 1): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "—";
  }
  return `${value.toFixed(digits)} ${unit}`;
}

function SummaryCard({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/75 p-4 shadow-lg shadow-slate-950/20">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className={`mt-2 font-mono text-2xl font-semibold ${accent ?? "text-white"}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function RunSelector({
  runs,
  total,
  selectedRunId,
  onSelect,
  onLoadMore,
  loadingMore,
}: {
  runs: CellRunSummary[];
  total: number;
  selectedRunId: number | null;
  onSelect: (runId: number) => void;
  onLoadMore: () => void;
  loadingMore: boolean;
}) {
  return (
    <aside className="rounded-3xl border border-slate-800 bg-slate-900/70 p-4 shadow-2xl shadow-slate-950/40">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Attempts</p>
          <h2 className="mt-1 text-lg font-semibold text-white">Run Archive</h2>
        </div>
        <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">
          {runs.length} / {total}
        </span>
      </div>
      <div className="max-h-[680px] space-y-2 overflow-y-auto pr-1">
        {runs.map((run) => {
          const active = run.run_id === selectedRunId;
          const badge = runStatusBadge(run);
          return (
            <button
              key={run.run_id}
              type="button"
              onClick={() => onSelect(run.run_id)}
              className={`w-full rounded-2xl border p-4 text-left transition ${
                active
                  ? "border-blue-400/60 bg-blue-500/10 shadow-lg shadow-blue-950/30"
                  : "border-slate-800 bg-slate-950/50 hover:border-slate-600 hover:bg-slate-900"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-sm font-semibold text-white">
                    Cell-{run.cell_id.toString().padStart(3, "0")}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    {run.board_ip} / CH{run.channel}
                  </p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-[11px] ring-1 ${badge.className}`}>
                  {badge.label}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-400">
                <span>{formatTimestamp(run.completed_at ?? run.started_at)}</span>
                <span className="text-right">{metricText(run.capacity_mah, "mAh", 0)}</span>
              </div>
            </button>
          );
        })}
        {runs.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-slate-500">No runs recorded yet.</p>
        ) : null}
      </div>
      {runs.length < total ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="mt-3 w-full rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-2 text-sm font-medium text-slate-200 hover:border-blue-400/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loadingMore ? "Loading…" : `Load more (${total - runs.length} remaining)`}
        </button>
      ) : null}
    </aside>
  );
}

type TimelineSegment = {
  state: string;
  startMs: number;
  endMs: number;
};

function buildTimeline(logs: CellLog[]): { segments: TimelineSegment[]; totalMs: number } {
  const segments: TimelineSegment[] = [];
  for (const log of logs) {
    const ms = parseMs(log.timestamp);
    if (ms === null) {
      continue;
    }
    const current = segments[segments.length - 1];
    if (!current || current.state !== log.state) {
      segments.push({ state: log.state, startMs: ms, endMs: ms });
    } else {
      current.endMs = ms;
    }
  }
  // Make segments contiguous: each stage ends where the next begins.
  for (let i = 0; i < segments.length - 1; i++) {
    segments[i]!.endMs = segments[i + 1]!.startMs;
  }
  const first = segments[0];
  const last = segments[segments.length - 1];
  const totalMs = first && last ? Math.max(0, last.endMs - first.startMs) : 0;
  return { segments, totalMs };
}

function StateTimeline({ run, logs }: { run: CellRunSummary; logs: CellLog[] }) {
  const { segments, totalMs } = useMemo(() => buildTimeline(logs), [logs]);
  const headerDuration = run.duration_ms ?? (totalMs > 0 ? totalMs : null);

  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-2xl shadow-slate-950/30">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Cycle State</p>
          <h3 className="mt-1 text-lg font-semibold text-white">Automation Timeline</h3>
        </div>
        <p className="text-sm text-slate-400">{formatDurationMs(headerDuration)}</p>
      </div>
      {segments.length > 0 && totalMs > 0 ? (
        <>
          <div className="flex h-4 overflow-hidden rounded-full bg-slate-950 ring-1 ring-slate-800">
            {segments.map((segment, index) => {
              const style = stateStyle(segment.state);
              const durationMs = Math.max(0, segment.endMs - segment.startMs);
              const width = (durationMs / totalMs) * 100;
              if (width <= 0) {
                return null;
              }
              return (
                <div
                  key={`${segment.state}-${index}`}
                  style={{ width: `${width}%`, backgroundColor: style.color }}
                  title={`${style.label}: ${formatDurationMs(durationMs)}`}
                />
              );
            })}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {segments.map((segment, index) => {
              const style = stateStyle(segment.state);
              const durationMs = Math.max(0, segment.endMs - segment.startMs);
              if (durationMs <= 0 && segment.state === "COMPLETE") {
                return null;
              }
              return (
                <span
                  key={`${segment.state}-legend-${index}`}
                  className={`rounded-full px-3 py-1 text-xs ring-1 ${style.className}`}
                >
                  {style.label}: {formatDurationMs(durationMs)}
                </span>
              );
            })}
          </div>
        </>
      ) : (
        <p className="text-sm text-slate-400">No timeline samples for this run yet.</p>
      )}
    </section>
  );
}

type ChartPoint = {
  ms: number;
  state: string;
  voltage: number;
  current: number;
  capacity: number;
  temp: number;
};

type MetricKey = "voltage" | "current" | "capacity" | "temp";

const METRICS: Array<{ key: MetricKey; label: string; unit: string; color: string; digits: number }> = [
  { key: "voltage", label: "Voltage", unit: "V", color: "#60a5fa", digits: 3 },
  { key: "current", label: "Current", unit: "A", color: "#f97316", digits: 3 },
  { key: "capacity", label: "Capacity", unit: "mAh", color: "#34d399", digits: 0 },
  { key: "temp", label: "Temperature", unit: "°C", color: "#c084fc", digits: 1 },
];

function signedCurrentMa(log: CellLog): number {
  if (log.state === "CHARGE_INITIAL" || log.state === "CHARGE_STORAGE") {
    return typeof log.ibat_ma === "number" && Number.isFinite(log.ibat_ma)
      ? Math.abs(log.ibat_ma)
      : Number.NaN;
  }
  if (log.state === "DISCHARGE") {
    return -Math.abs(log.current_ma);
  }
  return 0;
}

// SVG geometry (viewBox units). preserveAspectRatio="none" scales x linearly.
const VIEW_W = 1000;
const TRACK_H = 150;
const PAD_L = 70;
const PAD_R = 28;
const PAD_T = 18;
const PAD_B = 20;
const PLOT_LEFT_FRAC = PAD_L / VIEW_W;
const PLOT_RIGHT_FRAC = (VIEW_W - PAD_R) / VIEW_W;
const MAX_POINTS = 800;

function downsample(points: ChartPoint[]): ChartPoint[] {
  if (points.length <= MAX_POINTS) {
    return points;
  }
  const step = Math.ceil(points.length / MAX_POINTS);
  const out: ChartPoint[] = [];
  for (let i = 0; i < points.length; i += step) {
    out.push(points[i]!);
  }
  const last = points[points.length - 1]!;
  if (out[out.length - 1] !== last) {
    out.push(last);
  }
  return out;
}

function MetricTrack({
  metric,
  points,
  minMs,
  maxMs,
  segments,
  hoverIndex,
}: {
  metric: (typeof METRICS)[number];
  points: ChartPoint[];
  minMs: number;
  maxMs: number;
  segments: TimelineSegment[];
  hoverIndex: number | null;
}) {
  const values = points.map((p) => p[metric.key]).filter((v) => Number.isFinite(v));
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const pad = (max - min) * 0.08 || Math.abs(max) * 0.08 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const range = hi - lo || 1;
  const spanMs = maxMs - minMs || 1;

  const xFor = (ms: number) => PAD_L + ((ms - minMs) / spanMs) * (VIEW_W - PAD_L - PAD_R);
  const yFor = (value: number) => PAD_T + (1 - (value - lo) / range) * (TRACK_H - PAD_T - PAD_B);

  const line = points
    .reduce<{ path: string; drawing: boolean }>((result, p) => {
      const value = p[metric.key];
      if (!Number.isFinite(value)) {
        return { path: result.path, drawing: false };
      }
      const command = result.drawing ? "L" : "M";
      const point = `${command}${xFor(p.ms).toFixed(1)},${yFor(value).toFixed(1)}`;
      return {
        path: result.path ? `${result.path} ${point}` : point,
        drawing: true,
      };
    }, { path: "", drawing: false })
    .path;

  const hoverPoint = hoverIndex != null ? points[hoverIndex] : undefined;
  const hoverValue = hoverPoint?.[metric.key];

  return (
    <div className="relative">
      <div className="mb-1 flex items-center justify-between px-1 text-xs">
        <span className="font-semibold" style={{ color: metric.color }}>
          {metric.label}
        </span>
        <span className="font-mono text-slate-500">
          min {metricText(min, metric.unit, metric.digits)} · max {metricText(max, metric.unit, metric.digits)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${VIEW_W} ${TRACK_H}`}
        preserveAspectRatio="none"
        className="h-[150px] w-full rounded-xl border border-slate-800 bg-slate-950/70"
      >
        {segments.map((segment, index) => {
          const style = stateStyle(segment.state);
          const x0 = xFor(Math.max(segment.startMs, minMs));
          const x1 = xFor(Math.min(segment.endMs, maxMs));
          const w = Math.max(0, x1 - x0);
          if (w <= 0) {
            return null;
          }
          return (
            <rect
              key={`${segment.state}-${index}`}
              x={x0}
              y={PAD_T}
              width={w}
              height={TRACK_H - PAD_T - PAD_B}
              fill={style.color}
              opacity={0.08}
            />
          );
        })}
        {[0, 0.5, 1].map((frac) => {
          const y = PAD_T + frac * (TRACK_H - PAD_T - PAD_B);
          const value = hi - frac * range;
          return (
            <g key={frac}>
              <line
                x1={PAD_L}
                x2={VIEW_W - PAD_R}
                y1={y}
                y2={y}
                stroke="#1e293b"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <text x={PAD_L - 8} y={y + 4} textAnchor="end" fill="#64748b" fontSize={11}>
                {value.toFixed(metric.digits)}
              </text>
            </g>
          );
        })}
        {metric.key === "current" && lo < 0 && hi > 0 ? (
          <line
            x1={PAD_L}
            x2={VIEW_W - PAD_R}
            y1={yFor(0)}
            y2={yFor(0)}
            stroke="#94a3b8"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {line ? (
          <path
            d={line}
            fill="none"
            stroke={metric.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {hoverPoint ? (
          <g>
            <line
              x1={xFor(hoverPoint.ms)}
              x2={xFor(hoverPoint.ms)}
              y1={PAD_T}
              y2={TRACK_H - PAD_B}
              stroke="#e2e8f0"
              strokeWidth={1}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
            {typeof hoverValue === "number" && Number.isFinite(hoverValue) ? (
              <circle cx={xFor(hoverPoint.ms)} cy={yFor(hoverValue)} r={3.5} fill={metric.color} />
            ) : null}
          </g>
        ) : null}
      </svg>
    </div>
  );
}

function SynchronizedChart({ logs }: { logs: CellLog[] }) {
  const points = useMemo<ChartPoint[]>(() => {
    const raw: ChartPoint[] = [];
    for (const log of logs) {
      const ms = parseMs(log.timestamp);
      if (ms === null) {
        continue;
      }
      raw.push({
        ms,
        state: log.state,
        voltage: log.voltage_mv / 1000,
        current: signedCurrentMa(log) / 1000,
        capacity: log.capacity_mah,
        temp: log.temp_c,
      });
    }
    return downsample(raw);
  }, [logs]);

  const segments = useMemo(() => buildTimeline(logs).segments, [logs]);
  const [visible, setVisible] = useState<Record<MetricKey, boolean>>({
    voltage: true,
    current: true,
    capacity: true,
    temp: true,
  });
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const minMs = points.length ? points[0]!.ms : 0;
  const maxMs = points.length ? points[points.length - 1]!.ms : 1;
  const spanMs = maxMs - minMs || 1;

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const el = containerRef.current;
      if (!el || points.length === 0) {
        return;
      }
      const rect = el.getBoundingClientRect();
      const frac = (event.clientX - rect.left) / rect.width;
      const timeFrac = (frac - PLOT_LEFT_FRAC) / (PLOT_RIGHT_FRAC - PLOT_LEFT_FRAC);
      const clamped = Math.max(0, Math.min(1, timeFrac));
      const targetMs = minMs + clamped * spanMs;
      // Nearest sample by time.
      let nearest = 0;
      let bestDelta = Infinity;
      for (let i = 0; i < points.length; i++) {
        const delta = Math.abs(points[i]!.ms - targetMs);
        if (delta < bestDelta) {
          bestDelta = delta;
          nearest = i;
        }
      }
      setHoverIndex(nearest);
    },
    [points, minMs, spanMs],
  );

  const activeMetrics = METRICS.filter((m) => visible[m.key]);
  const hoverPoint = hoverIndex != null ? points[hoverIndex] : undefined;
  const hoverLeftPct = hoverPoint
    ? ((PAD_L + ((hoverPoint.ms - minMs) / spanMs) * (VIEW_W - PAD_L - PAD_R)) / VIEW_W) * 100
    : 0;

  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-2xl shadow-slate-950/30">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Measurements</p>
          <h3 className="mt-1 text-lg font-semibold text-white">Synchronized Cycle Graph</h3>
          <p className="mt-1 text-xs text-slate-400">
            Current uses IBAT for charging (+) and INA discharge current (−).
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {METRICS.map((metric) => {
            const on = visible[metric.key];
            return (
              <button
                key={metric.key}
                type="button"
                onClick={() => setVisible((prev) => ({ ...prev, [metric.key]: !prev[metric.key] }))}
                aria-pressed={on}
                className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition ${
                  on
                    ? "border-slate-600 bg-slate-800 text-white"
                    : "border-slate-800 bg-slate-950/50 text-slate-500"
                }`}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: on ? metric.color : "#475569" }}
                />
                {metric.label}
              </button>
            );
          })}
        </div>
      </div>

      {points.length > 1 ? (
        <>
          <div
            ref={containerRef}
            className="relative"
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverIndex(null)}
          >
            <div className="space-y-3">
              {activeMetrics.length > 0 ? (
                activeMetrics.map((metric) => (
                  <MetricTrack
                    key={metric.key}
                    metric={metric}
                    points={points}
                    minMs={minMs}
                    maxMs={maxMs}
                    segments={segments}
                    hoverIndex={hoverIndex}
                  />
                ))
              ) : (
                <p className="rounded-xl border border-slate-800 bg-slate-950/70 p-8 text-center text-sm text-slate-400">
                  Enable at least one metric to plot.
                </p>
              )}
            </div>

            {hoverPoint && activeMetrics.length > 0 ? (
              <div
                className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs shadow-xl"
                style={{
                  left: `${Math.min(88, Math.max(12, hoverLeftPct))}%`,
                }}
              >
                <p className="mb-1 font-mono text-slate-400">
                  {formatElapsed(hoverPoint.ms - minMs)} · {stateStyle(hoverPoint.state).label}
                </p>
                <div className="space-y-0.5">
                  {activeMetrics.map((metric) => (
                    <div key={metric.key} className="flex items-center justify-between gap-4">
                      <span className="flex items-center gap-1.5" style={{ color: metric.color }}>
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: metric.color }} />
                        {metric.label}
                      </span>
                      <span className="font-mono text-white">
                        {metricText(hoverPoint[metric.key], metric.unit, metric.digits)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {/* Shared elapsed-time axis aligned to the plot area. */}
          <div
            className="mt-2 flex justify-between text-[11px] text-slate-500"
            style={{ paddingLeft: `${PLOT_LEFT_FRAC * 100}%`, paddingRight: `${(1 - PLOT_RIGHT_FRAC) * 100}%` }}
          >
            {[0, 0.25, 0.5, 0.75, 1].map((frac) => (
              <span key={frac} className="font-mono">
                {formatElapsed(frac * spanMs)}
              </span>
            ))}
          </div>
        </>
      ) : (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-8 text-center text-sm text-slate-400">
          Not enough samples to plot this run.
        </div>
      )}
    </section>
  );
}

function LogsTable({ logs }: { logs: CellLog[] }) {
  const rows = logs.slice(-250);
  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-2xl shadow-slate-950/30">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Samples</p>
          <h3 className="mt-1 text-lg font-semibold text-white">Detailed Run Data</h3>
        </div>
        <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">
          {rows.length} of {logs.length} rows
        </span>
      </div>
      <div className="max-h-[420px] overflow-auto rounded-2xl border border-slate-800">
        <table className="w-full min-w-[840px] text-left text-sm text-slate-300">
          <thead className="sticky top-0 bg-slate-950 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Time</th>
              <th className="px-4 py-3 font-medium">State</th>
              <th className="px-4 py-3 font-medium">Voltage</th>
              <th className="px-4 py-3 font-medium">Current (+ charge / − discharge)</th>
              <th className="px-4 py-3 font-medium">Capacity</th>
              <th className="px-4 py-3 font-medium">Temp</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 bg-slate-950/50">
            {rows.map((log) => {
              const style = stateStyle(log.state);
              return (
                <tr key={log.id} className="hover:bg-slate-900">
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">{formatTimestamp(log.timestamp)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-xs ring-1 ${style.className}`}>{style.label}</span>
                  </td>
                  <td className="px-4 py-3 font-mono">{(log.voltage_mv / 1000).toFixed(3)} V</td>
                  <td
                    className="px-4 py-3 font-mono"
                    title={
                      log.state === "CHARGE_INITIAL" || log.state === "CHARGE_STORAGE"
                        ? "IBAT charge current"
                        : log.state === "DISCHARGE"
                          ? "INA discharge current"
                          : "No active charge or discharge"
                    }
                  >
                    {metricText(signedCurrentMa(log), "mA", 0)}
                  </td>
                  <td className="px-4 py-3 font-mono">{log.capacity_mah.toFixed(1)} mAh</td>
                  <td className="px-4 py-3 font-mono">{log.temp_c.toFixed(1)} C</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function HistoryPage() {
  const [runs, setRuns] = useState<CellRunSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ run: CellRunSummary; logs: CellLog[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRuns({ limit: PAGE_SIZE, offset: 0 })
      .then((data) => {
        if (cancelled) return;
        setRuns(data.runs);
        setTotal(data.total);
        setError(null);
        if (data.runs.length > 0) {
          setSelectedRunId((current) => current ?? data.runs[0]!.run_id);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load run archive");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (selectedRunId == null) {
      /* eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale detail when no run is selected */
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    setDetailError(null);
    fetchRun(selectedRunId)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setDetail(null);
          setDetailError(err instanceof Error ? err.message : "Failed to load run details");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetailLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  const handleLoadMore = useCallback(() => {
    setLoadingMore(true);
    fetchRuns({ limit: PAGE_SIZE, offset: runs.length })
      .then((data) => {
        setRuns((prev) => {
          const seen = new Set(prev.map((r) => r.run_id));
          return [...prev, ...data.runs.filter((r) => !seen.has(r.run_id))];
        });
        setTotal(data.total);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load more runs");
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [runs.length]);

  const selectedRun = detail?.run ?? runs.find((r) => r.run_id === selectedRunId) ?? null;
  const logs = detail?.logs ?? [];

  const restingMv = selectedRun?.resting_voltage_mv ?? null;
  const loadedMv = selectedRun?.active_voltage_mv ?? null;
  const sagMv =
    restingMv != null && loadedMv != null && loadedMv > 0 ? restingMv - loadedMv : null;

  return (
    <div className="min-h-full bg-[radial-gradient(circle_at_top_left,_rgba(37,99,235,0.22),_transparent_34%),#020617] text-slate-100">
      <header className="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-5">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-blue-300">Goblin HQ</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-white">Cell Analytics</h1>
            <p className="mt-1 text-sm text-slate-400">
              Every test attempt, charge/discharge curves, and capacity evidence · API {getApiBaseUrl()}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/ir"
              className="rounded-xl border border-violet-400/50 bg-violet-500/10 px-4 py-2 text-sm font-semibold text-violet-100 hover:border-violet-300 hover:text-white"
            >
              IR Test
            </Link>
            <Link
              href="/"
              className="rounded-xl border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-blue-400 hover:text-white"
            >
              Live Dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        {loading ? (
          <div className="lg:col-span-2 rounded-3xl border border-slate-800 bg-slate-900/70 p-8 text-slate-300">
            Loading run archive…
          </div>
        ) : error ? (
          <div className="lg:col-span-2 rounded-3xl border border-rose-500/40 bg-rose-500/10 p-8 text-rose-100">
            {error}
          </div>
        ) : runs.length === 0 ? (
          <div className="lg:col-span-2 rounded-3xl border border-slate-800 bg-slate-900/70 p-8 text-slate-300">
            No cell history yet. Start an automation cycle and the hub will record each run here.
          </div>
        ) : (
          <>
            <RunSelector
              runs={runs}
              total={total}
              selectedRunId={selectedRunId}
              onSelect={setSelectedRunId}
              onLoadMore={handleLoadMore}
              loadingMore={loadingMore}
            />
            <section className="space-y-6">
              {selectedRun ? (
                <>
                  <div className="overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/70 shadow-2xl shadow-slate-950/40">
                    <div className="border-b border-slate-800 bg-gradient-to-r from-blue-500/10 via-slate-900 to-emerald-500/10 px-6 py-5">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Selected Run</p>
                          <h2 className="mt-1 font-mono text-3xl font-semibold text-white">
                            Cell-{selectedRun.cell_id.toString().padStart(3, "0")}
                          </h2>
                          <p className="mt-1 text-sm text-slate-400">
                            {selectedRun.board_ip} / Channel {selectedRun.channel} · {selectedRun.sample_count} samples ·{" "}
                            {formatTimestamp(selectedRun.completed_at ?? selectedRun.started_at)}
                          </p>
                          {selectedRun.status === "fault" && selectedRun.fault_reason ? (
                            <p className="mt-1 text-sm text-rose-300">Fault: {selectedRun.fault_reason}</p>
                          ) : null}
                        </div>
                        <span
                          className={`rounded-full px-4 py-2 text-sm font-semibold ring-1 ${runStatusBadge(selectedRun).className}`}
                        >
                          {runStatusBadge(selectedRun).label}
                        </span>
                      </div>
                    </div>
                    <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-3">
                      <SummaryCard
                        label="Final Capacity"
                        value={metricText(selectedRun.capacity_mah, "mAh", 0)}
                        accent="text-emerald-200"
                      />
                      <SummaryCard
                        label="Rest Voltage"
                        value={restingMv != null ? metricText(restingMv / 1000, "V", 3) : "—"}
                        hint="After 5 min rest"
                      />
                      <SummaryCard
                        label="Loaded Voltage"
                        value={loadedMv != null && loadedMv > 0 ? metricText(loadedMv / 1000, "V", 3) : "—"}
                        hint="5 min into discharge"
                      />
                      <SummaryCard
                        label="Voltage Sag"
                        value={sagMv != null ? metricText(sagMv / 1000, "V", 3) : "—"}
                        hint="Rest − loaded"
                        accent="text-amber-200"
                      />
                      <SummaryCard
                        label="Run Duration"
                        value={formatDurationMs(selectedRun.duration_ms)}
                        hint={selectedRun.status === "running" ? "Still running" : "Start to completion"}
                      />
                      <SummaryCard
                        label="Initial Charge"
                        value={formatDurationMs(selectedRun.initial_charge_duration_ms)}
                        accent="text-amber-200"
                      />
                      <SummaryCard
                        label="Discharge"
                        value={formatDurationMs(selectedRun.discharge_duration_ms)}
                        accent="text-rose-200"
                      />
                    </div>
                  </div>

                  {detailError ? (
                    <div className="rounded-3xl border border-rose-500/40 bg-rose-500/10 p-6 text-rose-100">
                      {detailError}
                    </div>
                  ) : detailLoading && logs.length === 0 ? (
                    <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-8 text-slate-300">
                      Loading run samples…
                    </div>
                  ) : (
                    <>
                      <StateTimeline run={selectedRun} logs={logs} />
                      <SynchronizedChart logs={logs} />
                      <LogsTable logs={logs} />
                    </>
                  )}
                </>
              ) : null}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
