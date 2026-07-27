"use client";

import { BoardOverview } from "@/components/BoardOverview";
import { ChannelCard } from "@/components/ChannelCard";
import Link from "next/link";
import {
  allOff,
  clearBoardCrashes,
  clearHistoricalData,
  fetchConfig,
  fetchCrashes,
  fetchResults,
  getApiBaseUrl,
  getWsUrl,
  resetAllFinished,
  setChemistry,
  startAllAutomation,
  startAutomation,
  stopAutomation,
  testHomeAssistantIntegration,
  updateConfig,
} from "@/lib/api";
import { baySlotCount, sortBoardsForDisplay } from "@/lib/board-layout";
import { computeFleetExtremes } from "@/lib/fleet-extremes";
import {
  computeRangeAlertHighlights,
  formatRangeAlertTitle,
} from "@/lib/range-alerts";
import { ensureAudioUnlockListeners, playAlertSound } from "@/lib/sounds";
import type {
  CellResult,
  ChemistryId,
  CrashEvent,
  CrashSummary,
  HubConfig,
  RangeAlert,
  StatusResponse,
} from "@/lib/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

export default function DashboardPage() {
  const [boardStates, setBoardStates] = useState<Record<string, StatusResponse>>({});
  const [config, setConfig] = useState<HubConfig | null>(null);
  const [results, setResults] = useState<CellResult[]>([]);
  const [crashSummaries, setCrashSummaries] = useState<Record<string, CrashSummary>>({});
  const [crashEvents, setCrashEvents] = useState<CrashEvent[]>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [newIp, setNewIp] = useState("");
  const [expandedBoards, setExpandedBoards] = useState<Set<string>>(() => new Set());
  const [showClearData, setShowClearData] = useState(false);
  const [clearDataConfirmation, setClearDataConfirmation] = useState("");
  const [resetNextCellId, setResetNextCellId] = useState(true);
  const [dataClearMessage, setDataClearMessage] = useState<string | null>(null);
  const [fleetActionMessage, setFleetActionMessage] = useState<string | null>(null);
  const [integrationTestMessage, setIntegrationTestMessage] = useState<string | null>(null);
  const [rangeAlerts, setRangeAlerts] = useState<RangeAlert[]>([]);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(() => {
    if (typeof window === "undefined" || typeof Notification === "undefined") {
      return "unsupported";
    }
    return Notification.permission;
  });
  const seenAlertKeysRef = useRef<Set<string>>(new Set());
  const alertsHydratedRef = useRef(false);

  const refreshConfigAndResults = useCallback(async () => {
    try {
      const [cfg, res, crashes] = await Promise.all([fetchConfig(), fetchResults(), fetchCrashes()]);
      setConfig(cfg);
      setResults(res);
      const summaryMap: Record<string, CrashSummary> = {};
      crashes.summaries.forEach((summary) => {
        summaryMap[summary.boardIp] = summary;
      });
      setCrashSummaries(summaryMap);
      setCrashEvents(crashes.events);
      setConnectionError(null);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "Failed to reach Hub API");
    }
  }, []);

  const orderedBoardIps = useMemo(() => {
    const preferred = config?.boards ?? [];
    const known = new Set<string>([...preferred, ...Object.keys(boardStates)]);
    return sortBoardsForDisplay(known, preferred);
  }, [boardStates, config?.boards]);

  const fleetExtremes = useMemo(
    () => computeFleetExtremes(boardStates),
    [boardStates],
  );

  const rangeHighlights = useMemo(
    () => computeRangeAlertHighlights(rangeAlerts),
    [rangeAlerts],
  );

  const fleetActionCounts = useMemo(() => {
    let ready = 0;
    let finished = 0;
    for (const status of Object.values(boardStates)) {
      for (let index = 0; index < 2; index += 1) {
        const state = status?.automation?.[index]?.state;
        if (status?.online && status?.channels?.[index]?.cellPresent && state === "IDLE") {
          ready += 1;
        }
        if (status?.online && (state === "COMPLETE" || state === "FAULT")) {
          finished += 1;
        }
      }
    }
    return { ready, finished };
  }, [boardStates]);

  useEffect(() => {
    ensureAudioUnlockListeners();
  }, []);

  useEffect(() => {
    const initialRefreshTimer = setTimeout(() => {
      void refreshConfigAndResults();
    }, 0);
    
    let ws: WebSocket;
    let reconnectTimer: NodeJS.Timeout;
    const crashRefreshTimer = setInterval(() => {
      void fetchCrashes()
        .then((crashes) => {
          const summaryMap: Record<string, CrashSummary> = {};
          crashes.summaries.forEach((summary) => {
            summaryMap[summary.boardIp] = summary;
          });
          setCrashSummaries(summaryMap);
          setCrashEvents(crashes.events);
        })
        .catch(() => {
          // keep last known crash data
        });
    }, 10000);

    const connectWs = () => {
      ws = new WebSocket(getWsUrl());
      
      ws.onopen = () => {
        setConnectionError(null);
      };
      
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'state') {
            setBoardStates(msg.data);
            if (Array.isArray(msg.alerts)) {
              setRangeAlerts(msg.alerts as RangeAlert[]);
            }
          }
        } catch (err) {
          console.error("Failed to parse WS message", err);
        }
      };
      
      ws.onclose = () => {
        setConnectionError("WebSocket disconnected. Reconnecting...");
        reconnectTimer = setTimeout(connectWs, 2000);
      };
      
      ws.onerror = () => {
        ws.close();
      };
    };

    connectWs();

    return () => {
      clearTimeout(initialRefreshTimer);
      clearTimeout(reconnectTimer);
      clearInterval(crashRefreshTimer);
      if (ws) ws.close();
    };
  }, [refreshConfigAndResults]);

  useEffect(() => {
    const currentKeys = new Set(rangeAlerts.map((alert) => alert.key));
    const newAlerts = rangeAlerts.filter((alert) => !seenAlertKeysRef.current.has(alert.key));

    // First snapshot after connect may already include active alerts — show the
    // banner but do not sound/notify until a fresh crossing arrives.
    if (!alertsHydratedRef.current) {
      seenAlertKeysRef.current = currentKeys;
      alertsHydratedRef.current = true;
      return;
    }

    for (const key of [...seenAlertKeysRef.current]) {
      if (!currentKeys.has(key)) {
        seenAlertKeysRef.current.delete(key);
      }
    }

    if (newAlerts.length === 0) {
      return;
    }

    for (const alert of newAlerts) {
      seenAlertKeysRef.current.add(alert.key);
    }

    void playAlertSound();

    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const body = newAlerts.map((alert) => alert.message).join("; ");
      try {
        new Notification("Battery tester out of range", {
          body,
          tag: "battery-tester-range-alert",
        });
      } catch {
        // Notification construction can fail in insecure contexts; banner still shows.
      }
    }
  }, [rangeAlerts]);

  const handleEnableBrowserAlerts = async () => {
    if (typeof Notification === "undefined") {
      setNotificationPermission("unsupported");
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
  };

  const handleAllOff = async (ip: string) => {
    setBusy(true);
    setCommandError(null);
    try {
      await allOff(ip);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "All off failed");
    } finally {
      setBusy(false);
    }
  };

  const handleClearCrashState = async (ip: string) => {
    setBusy(true);
    setCommandError(null);
    try {
      await clearBoardCrashes(ip);
      const crashes = await fetchCrashes();
      const summaryMap: Record<string, CrashSummary> = {};
      crashes.summaries.forEach((summary) => {
        summaryMap[summary.boardIp] = summary;
      });
      setCrashSummaries(summaryMap);
      setCrashEvents(crashes.events);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Failed to clear crash state");
    } finally {
      setBusy(false);
    }
  };

  const handleStartAuto = async (ip: string, channel: 1 | 2) => {
    setBusy(true);
    setCommandError(null);
    try {
      await startAutomation({ boardIp: ip, channel, mode: "new" });
      await refreshConfigAndResults();
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Failed to start automation");
    } finally {
      setBusy(false);
    }
  };

  const handleRetest = async (ip: string, channel: 1 | 2, cellId: number) => {
    setBusy(true);
    setCommandError(null);
    try {
      await startAutomation({ boardIp: ip, channel, mode: "retest", cellId });
      await refreshConfigAndResults();
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Failed to restart test");
    } finally {
      setBusy(false);
    }
  };

  const handleStopAuto = async (ip: string, channel: 1 | 2) => {
    setBusy(true);
    setCommandError(null);
    try {
      await stopAutomation({ boardIp: ip, channel });
      await refreshConfigAndResults();
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Failed to stop automation");
    } finally {
      setBusy(false);
    }
  };

  const handleStartAll = async () => {
    const expectedBays = config ? baySlotCount(config.boards) : 0;
    const readyBays = fleetActionCounts.ready;
    let force = false;
    if (expectedBays > 0 && readyBays < expectedBays) {
      const proceed = window.confirm(
        `Only ${readyBays} of ${expectedBays} bays are ready (cell present + IDLE).\n\n` +
          `Starting now will skip the rest and can throw off cell numbering.\n\n` +
          `Start ${readyBays} bay${readyBays === 1 ? "" : "s"} anyway?`,
      );
      if (!proceed) return;
      force = true;
    }

    setBusy(true);
    setCommandError(null);
    setFleetActionMessage(null);
    try {
      const response = await startAllAutomation({ force });
      if (response.failed > 0) {
        const failures = response.results
          .filter((result) => !result.ok)
          .map((result) => `${result.boardIp}/CH${result.channel}: ${result.error ?? "failed"}`)
          .join("; ");
        setCommandError(
          `Started ${response.succeeded} of ${response.attempted} ready bays. ${failures}`,
        );
      } else if (response.attempted === 0) {
        setFleetActionMessage("No idle bays with a detected cell are ready to start.");
      } else {
        setFleetActionMessage(
          `Started ${response.succeeded} bays sequentially with ${response.delayMs / 1000}s spacing` +
            (force ? " (forced partial fleet)." : "."),
        );
      }
      await refreshConfigAndResults();
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Failed to start all ready bays");
    } finally {
      setBusy(false);
    }
  };

  const handleResetAll = async () => {
    setBusy(true);
    setCommandError(null);
    setFleetActionMessage(null);
    try {
      const response = await resetAllFinished();
      if (response.failed > 0) {
        const failures = response.results
          .filter((result) => !result.ok)
          .map((result) => `${result.boardIp}/CH${result.channel}: ${result.error ?? "failed"}`)
          .join("; ");
        setCommandError(
          `Reset ${response.succeeded} of ${response.attempted} finished bays. ${failures}`,
        );
      } else if (response.attempted === 0) {
        setFleetActionMessage("No completed or faulted bays need to be reset.");
      } else {
        setFleetActionMessage(`Reset ${response.succeeded} finished bays. Active tests were not touched.`);
      }
      await refreshConfigAndResults();
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Failed to reset finished bays");
    } finally {
      setBusy(false);
    }
  };

  const toggleBoardExpanded = (ip: string) => {
    setExpandedBoards((current) => {
      const next = new Set(current);
      if (next.has(ip)) {
        next.delete(ip);
      } else {
        next.add(ip);
      }
      return next;
    });
  };

  const handleChemistryChange = async (ip: string, chemistry: ChemistryId) => {
    setBusy(true);
    setCommandError(null);
    try {
      const response = await setChemistry(ip, chemistry);
      setBoardStates((current) => ({
        ...current,
        [ip]: {
          ...current[ip],
          chemistry: response.chemistry,
        },
      }));
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Failed to change chemistry");
    } finally {
      setBusy(false);
    }
  };

  const handleAddBoard = async () => {
    if (!newIp || !config) return;
    try {
      await updateConfig({ boards: [...config.boards, newIp] });
      setNewIp("");
      await refreshConfigAndResults();
    } catch {
      alert("Failed to add board");
    }
  };

  const handleRemoveBoard = async (ip: string) => {
    if (!config) return;
    try {
      await updateConfig({ boards: config.boards.filter((b) => b !== ip) });
      await refreshConfigAndResults();
    } catch {
      alert("Failed to remove board");
    }
  };

  const handleUpdateThreshold = async (val: string) => {
    if (!config) return;
    try {
      await updateConfig({ passThresholdMah: parseInt(val, 10) });
      await refreshConfigAndResults();
    } catch {
      alert("Failed to update threshold");
    }
  };

  const handleTestHomeAssistant = async () => {
    setBusy(true);
    setCommandError(null);
    setIntegrationTestMessage(null);
    try {
      const response = await testHomeAssistantIntegration();
      setIntegrationTestMessage(response.message);
    } catch (error) {
      setCommandError(
        error instanceof Error ? error.message : "Failed to send Home Assistant test alert",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleClearHistoricalData = async () => {
    setBusy(true);
    setCommandError(null);
    setDataClearMessage(null);
    try {
      const response = await clearHistoricalData(clearDataConfirmation, resetNextCellId);
      setResults([]);
      setCrashSummaries({});
      setCrashEvents([]);
      setConfig((current) =>
        current ? { ...current, nextCellId: response.nextCellId } : current,
      );
      setClearDataConfirmation("");
      setShowClearData(false);
      setDataClearMessage(
        `Cleared ${response.deleted.results} tests, ${response.deleted.logs} samples, and ${response.deleted.crashes} crash events.`,
      );
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Failed to clear historical data");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/90">
        <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6">
          <div>
            <h1 className="text-2xl font-semibold text-white">
              Goblin HQ
            </h1>
            <p className="text-sm text-slate-400">
              LAN control dashboard · API {getApiBaseUrl()}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || fleetActionCounts.finished === 0}
              onClick={() => void handleResetAll()}
              title="Reset every completed or faulted bay; active tests are never interrupted"
              className="rounded-lg border border-emerald-400/50 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-100 hover:border-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reset All ({fleetActionCounts.finished})
            </button>
            <button
              type="button"
              disabled={busy || fleetActionCounts.ready === 0}
              onClick={() => void handleStartAll()}
              title="Start every ready bay sequentially with a 2 second delay"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Fleet action…" : `Start All (${fleetActionCounts.ready})`}
            </button>
            <Link
              href="/ir"
              className="rounded-lg border border-violet-400/50 bg-violet-500/10 px-4 py-2 text-sm font-semibold text-violet-100 hover:border-violet-300 hover:bg-violet-500/20"
            >
              IR Test
            </Link>
            <Link
              href="/history"
              className="rounded-lg border border-blue-400/50 bg-blue-500/10 px-4 py-2 text-sm font-semibold text-blue-100 hover:border-blue-300 hover:bg-blue-500/20"
            >
              Cell Analytics
            </Link>
            <button
              type="button"
              onClick={() => setShowSettings(!showSettings)}
              className="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:bg-slate-800"
            >
              Settings
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1800px] space-y-6 px-4 py-6 sm:px-6">
        {showSettings && config && (
          <div className="rounded-2xl border border-slate-700 bg-slate-800/50 px-6 py-5">
            <h2 className="text-lg font-medium text-white mb-4">Settings</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Pass Threshold (mAh)</label>
                <input 
                  type="number" 
                  defaultValue={config.passThresholdMah}
                  onBlur={(e) => handleUpdateThreshold(e.target.value)}
                  className="rounded bg-slate-900 border border-slate-700 px-3 py-1.5 text-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">Boards (IP addresses)</label>
                <p className="mb-2 text-xs text-slate-400">
                  Add boards left → right to match your physical tester. This order drives the dashboard and Start All.
                </p>
                <ul className="space-y-2 mb-2">
                  {config.boards.map((ip) => (
                    <li key={ip} className="flex items-center gap-2">
                      <span className="bg-slate-900 px-2 py-1 rounded text-sm font-mono">{ip}</span>
                      <button onClick={() => handleRemoveBoard(ip)} className="text-rose-400 hover:text-rose-300 text-sm">Remove</button>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    value={newIp}
                    onChange={(e) => setNewIp(e.target.value)}
                    placeholder="e.g. 192.168.1.50"
                    className="rounded bg-slate-900 border border-slate-700 px-3 py-1.5 text-white"
                  />
                  <button onClick={handleAddBoard} className="bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 rounded text-sm font-medium">Add Board</button>
                </div>
              </div>
              <div className="border-t border-slate-700 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-white">Home Assistant alerts</h3>
                    <p className="mt-1 text-sm text-slate-400">
                      Sends a real test announcement to Alexa and a phone notification.
                      Out-of-range cell temp, heatsink, and voltage also use this webhook.
                    </p>
                    {integrationTestMessage ? (
                      <p className="mt-2 text-sm text-emerald-300">{integrationTestMessage}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleTestHomeAssistant()}
                    className="rounded-lg border border-blue-400/50 bg-blue-500/10 px-4 py-2 text-sm font-semibold text-blue-100 hover:border-blue-300 hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? "Sending…" : "Send test alert"}
                  </button>
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-white">Browser desktop notifications</h3>
                    <p className="mt-1 text-sm text-slate-400">
                      When enabled, new out-of-range readings also raise a system notification
                      while this dashboard tab is open.
                    </p>
                    <p className="mt-2 text-sm text-slate-500">
                      Status:{" "}
                      {notificationPermission === "granted"
                        ? "enabled"
                        : notificationPermission === "denied"
                          ? "blocked by the browser"
                          : notificationPermission === "unsupported"
                            ? "not supported in this browser"
                            : "not enabled yet"}
                    </p>
                  </div>
                  {notificationPermission === "default" ? (
                    <button
                      type="button"
                      onClick={() => void handleEnableBrowserAlerts()}
                      className="rounded-lg border border-amber-400/50 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-100 hover:border-amber-300 hover:bg-amber-500/20"
                    >
                      Enable notifications
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="border-t border-slate-700 pt-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-rose-300">Clear historical data</h3>
                    <p className="mt-1 max-w-2xl text-sm text-slate-400">
                      Permanently delete all completed tests, measurement history, crash events, and crash recovery state.
                      Board addresses, chemistry, and thresholds are preserved.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setShowClearData((current) => !current);
                      setClearDataConfirmation("");
                    }}
                    className="rounded-lg border border-rose-500/50 bg-rose-500/10 px-4 py-2 text-sm font-semibold text-rose-200 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Clear tests and crashes
                  </button>
                </div>

                {showClearData ? (
                  <div className="mt-4 rounded-xl border border-rose-500/40 bg-rose-950/30 p-4">
                    <p className="font-semibold text-rose-100">This cannot be undone.</p>
                    <p className="mt-1 text-sm text-rose-200/80">
                      Stop every active test first. Type <span className="font-mono font-semibold text-rose-100">CLEAR ALL DATA</span> to confirm.
                    </p>
                    <input
                      type="text"
                      value={clearDataConfirmation}
                      onChange={(event) => setClearDataConfirmation(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="CLEAR ALL DATA"
                      aria-label="Type CLEAR ALL DATA to confirm"
                      className="mt-3 w-full max-w-sm rounded-lg border border-rose-500/40 bg-slate-950 px-3 py-2 font-mono text-sm text-white outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-400/20"
                    />
                    <label className="mt-3 flex w-fit cursor-pointer items-center gap-2 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        checked={resetNextCellId}
                        onChange={(event) => setResetNextCellId(event.target.checked)}
                        className="h-4 w-4 accent-rose-600"
                      />
                      Restart cell numbering at Cell-001
                    </label>
                    <div className="mt-4 flex flex-wrap gap-3">
                      <button
                        type="button"
                        disabled={busy || clearDataConfirmation !== "CLEAR ALL DATA"}
                        onClick={() => void handleClearHistoricalData()}
                        className="rounded-lg bg-rose-700 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {busy ? "Clearing…" : "Permanently clear data"}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setShowClearData(false);
                          setClearDataConfirmation("");
                        }}
                        className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}

        {connectionError ? (
          <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {connectionError}
          </div>
        ) : null}

        {rangeAlerts.length > 0 ? (
          <div
            role="alert"
            aria-live="assertive"
            className="rounded-2xl border border-rose-500/50 bg-rose-500/15 px-4 py-3 text-sm text-rose-50"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-rose-100">
                  {rangeAlerts.length === 1
                    ? "1 value out of range"
                    : `${rangeAlerts.length} values out of range`}
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-rose-100/95">
                  {rangeAlerts.map((alert) => (
                    <li key={alert.key}>
                      <span className="font-medium">{formatRangeAlertTitle(alert)}</span>
                      <span className="text-rose-200/80"> — {alert.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
              {notificationPermission === "default" ? (
                <button
                  type="button"
                  onClick={() => void handleEnableBrowserAlerts()}
                  className="shrink-0 rounded-lg border border-rose-300/40 bg-rose-950/40 px-3 py-1.5 text-xs font-semibold text-rose-50 hover:bg-rose-900/50"
                >
                  Enable desktop notifications
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {commandError && (
          <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            Command failed: {commandError}
          </div>
        )}

        {dataClearMessage ? (
          <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
            {dataClearMessage}
          </div>
        ) : null}

        {fleetActionMessage ? (
          <div className="rounded-2xl border border-blue-500/40 bg-blue-500/10 px-4 py-3 text-sm text-blue-100">
            {fleetActionMessage}
          </div>
        ) : null}

        <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {orderedBoardIps.map((ip) => {
            const status = boardStates[ip];
            const crash = status?.crash ?? crashSummaries[ip];
            const isExpanded = expandedBoards.has(ip);
            const passThresholdMah = config?.passThresholdMah || 2200;
            const chemistryChangeBlocked =
              status?.automation?.some((automation) => automation.state !== "IDLE") ||
              status?.channels?.some((channel) => channel.chargeEnabled || channel.dischargeDuty > 0);
            return (
              <section
                key={ip}
                className={`overflow-hidden rounded-2xl border bg-slate-950 shadow-[0_18px_50px_rgba(0,0,0,0.45)] transition-all duration-300 ${
                  crash && crash.unresolvedCrashes > 0
                    ? "border-rose-500/45"
                    : isExpanded
                      ? "border-slate-500"
                      : "border-slate-800"
                } ${
                  isExpanded
                    ? "sm:col-span-2 lg:col-span-3 xl:col-span-5"
                    : ""
                }`}
              >
                <div className={isExpanded ? "grid gap-0 xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]" : ""}>
                  <BoardOverview
                    ip={ip}
                    status={status}
                    crash={crash}
                    passThresholdMah={passThresholdMah}
                    isExpanded={isExpanded}
                    busy={busy}
                    extremes={fleetExtremes}
                    rangeHighlights={rangeHighlights}
                    onToggleExpanded={() => toggleBoardExpanded(ip)}
                    onStartAuto={(channel) => void handleStartAuto(ip, channel)}
                    onStopAuto={(channel) => void handleStopAuto(ip, channel)}
                    onRetest={(channel, cellId) => void handleRetest(ip, channel, cellId)}
                  />

                  {isExpanded ? (
                    <div
                      id={`board-details-${ip.replaceAll(".", "-")}`}
                      className="space-y-6 border-t border-slate-800 px-4 py-5 xl:border-l xl:border-t-0 sm:px-5"
                    >
                      <div className="flex flex-wrap items-end justify-end gap-3">
                        <label className="flex min-w-64 flex-col gap-1 text-sm">
                          <span className="flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-wide text-slate-400">
                            Board chemistry
                            {status?.chemistry ? (
                              <span className="normal-case tracking-normal text-slate-500">
                                Max {(status.chemistry.maxChargeVoltageMv / 1000).toFixed(2)} V
                              </span>
                            ) : null}
                          </span>
                          <select
                            value={status?.chemistry?.id ?? ""}
                            disabled={busy || !status?.online || chemistryChangeBlocked || !status?.chemistry}
                            onChange={(event) =>
                              void handleChemistryChange(ip, event.target.value as ChemistryId)
                            }
                            className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label={`Battery chemistry for board ${ip}`}
                          >
                            {!status?.chemistry ? <option value="">Chemistry unavailable</option> : null}
                            <option value="lifepo4">LiFePO4 · 3.60 V max</option>
                            <option value="nmc_18650">18650 Li-ion (NMC) · 4.20 V max</option>
                          </select>
                          {chemistryChangeBlocked ? (
                            <span className="text-xs normal-case text-amber-300">
                              Stop both bays before changing chemistry.
                            </span>
                          ) : (
                            <span className="text-xs normal-case text-slate-500">
                              Applies to both bays and is saved on the board.
                            </span>
                          )}
                        </label>
                        <button
                          type="button"
                          disabled={busy || !status?.online}
                          onClick={() => void handleAllOff(ip)}
                          className="rounded-lg bg-rose-700 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-600 disabled:opacity-40"
                        >
                          ALL OFF ({ip})
                        </button>
                      </div>

                      {crash && crash.unresolvedCrashes > 0 && (
                        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="space-y-1">
                              <p className="font-semibold">
                                Crash detected ({crash.unresolvedCrashes} unresolved / {crash.totalCrashes} total)
                              </p>
                              <p className="text-xs text-rose-200/90">
                                Last crash: {crash.lastCrashAtMs ? new Date(crash.lastCrashAtMs).toLocaleString() : "unknown"}
                                {crash.blocked ? " · Recovery blocked (boot loop protection)" : ""}
                              </p>
                            </div>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleClearCrashState(ip)}
                              className="rounded-lg border border-rose-300/50 px-3 py-1.5 text-xs font-semibold text-rose-100 hover:bg-rose-500/20 disabled:opacity-40"
                            >
                              Clear Crash State
                            </button>
                          </div>
                        </div>
                      )}

                      {status?.online && status.channels && status.automation ? (
                        <>
                          <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-6">
                            <MetricCard label="Heatsink" value={status.thermistors[1]?.temperatureC?.toFixed(1) ?? "—"} unit="°C" />
                            <MetricCard label="Fan" value={status.system.fanOn ? "ON" : "OFF"} />
                            <MetricCard label="Reset Reason" value={status.system.resetReason ?? "—"} />
                            <MetricCard label="Uptime" value={formatDurationMs(status.system.uptimeMs)} />
                          </div>
                          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                            <ChannelCard
                              ip={ip}
                              channel={status.channels[1]}
                              auto={status.automation[1]}
                              ina={status.ina[1]}
                              thermistor={status.thermistors[0]}
                              limits={status.limits}
                              busy={busy}
                              onBusy={setBusy}
                              onError={setCommandError}
                              passThresholdMah={passThresholdMah}
                            />
                            <ChannelCard
                              ip={ip}
                              channel={status.channels[0]}
                              auto={status.automation[0]}
                              ina={status.ina[0]}
                              thermistor={status.thermistors[2]}
                              limits={status.limits}
                              busy={busy}
                              onBusy={setBusy}
                              onError={setCommandError}
                              passThresholdMah={passThresholdMah}
                            />
                          </div>
                        </>
                      ) : (
                        <div className="text-slate-500 italic">Board offline or initializing...</div>
                      )}
                    </div>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
        
        {results.length > 0 && (
          <div className="mt-12">
            <h2 className="text-xl font-medium text-white mb-4">Recent Results</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="bg-slate-800/50 text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">Time</th>
                    <th className="px-4 py-3 font-medium">Cell ID</th>
                    <th className="px-4 py-3 font-medium">Board / Bay</th>
                    <th className="px-4 py-3 font-medium">Duration</th>
                    <th className="px-4 py-3 font-medium">Capacity</th>
                    <th className="px-4 py-3 font-medium">Resting V</th>
                    <th className="px-4 py-3 font-medium">Sag V</th>
                    <th className="px-4 py-3 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {results.map((r) => (
                    <tr key={r.run_id} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3">{r.timestamp ? new Date(r.timestamp).toLocaleString() : "—"}</td>
                      <td className="px-4 py-3 font-mono">Cell-{r.cell_id.toString().padStart(3, '0')}</td>
                      <td className="px-4 py-3 font-mono">{r.board_ip} / CH{r.channel}</td>
                      <td className="px-4 py-3 font-mono text-xs">{formatDurationMs(r.duration_ms)}</td>
                      <td className="px-4 py-3">{typeof r.capacity_mah === "number" ? `${r.capacity_mah.toFixed(1)} mAh` : "—"}</td>
                      <td className="px-4 py-3">{typeof r.resting_voltage_mv === "number" ? `${r.resting_voltage_mv} mV` : "—"}</td>
                      <td className="px-4 py-3">{typeof r.active_voltage_mv === "number" && r.active_voltage_mv > 0 ? `${r.active_voltage_mv} mV` : "—"}</td>
                      <td className="px-4 py-3">{renderResultBadge(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {crashEvents.length > 0 && (
          <div className="mt-12">
            <h2 className="text-xl font-medium text-white mb-4">Reset / Crash Log</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="bg-slate-800/50 text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">Time</th>
                    <th className="px-4 py-3 font-medium">Board</th>
                    <th className="px-4 py-3 font-medium">Reason</th>
                    <th className="px-4 py-3 font-medium">Boot ID</th>
                    <th className="px-4 py-3 font-medium">Recovery</th>
                    <th className="px-4 py-3 font-medium">Last Status Before Crash</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {crashEvents.map((event) => (
                    <tr key={event.id} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3">{new Date(event.timestampMs).toLocaleString()}</td>
                      <td className="px-4 py-3 font-mono">{event.boardIp}</td>
                      <td className="px-4 py-3">
                        <span className="font-medium">{event.resetReason ?? "unknown"}</span>
                        <span className="ml-2 text-xs text-slate-400">({event.eventType})</span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{event.bootId ?? "—"}</td>
                      <td className="px-4 py-3 text-xs">
                        {event.recoveryAttempted ? (
                          event.recoveryAllowed ? "attempted+allowed" : "attempted+blocked"
                        ) : (
                          "not-attempted"
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-300">{summarizeCrashSnapshot(event.lastStatus)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function renderResultBadge(r: CellResult) {
  const base = "inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset";
  if (r.status === "complete") {
    return r.passed ? (
      <span className={`${base} bg-emerald-400/10 text-emerald-400 ring-emerald-400/20`}>PASS</span>
    ) : (
      <span className={`${base} bg-rose-400/10 text-rose-400 ring-rose-400/20`}>FAIL</span>
    );
  }
  if (r.status === "fault") {
    return <span className={`${base} bg-rose-500/10 text-rose-300 ring-rose-400/20`}>FAULT</span>;
  }
  if (r.status === "stopped") {
    return <span className={`${base} bg-slate-500/10 text-slate-300 ring-slate-400/20`}>STOPPED</span>;
  }
  return <span className={`${base} bg-amber-400/10 text-amber-300 ring-amber-400/20`}>{r.status.toUpperCase()}</span>;
}

function MetricCard({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-medium text-white">
        {value} {unit && <span className="text-slate-400">{unit}</span>}
      </p>
    </div>
  );
}

function summarizeCrashSnapshot(lastStatus: Record<string, unknown> | null): string {
  if (!lastStatus) {
    return "No status snapshot";
  }
  const system = lastStatus.system;
  const resetReason =
    system && typeof system === "object"
      ? String((system as Record<string, unknown>).resetReason ?? "")
      : "";
  const automation = Array.isArray(lastStatus.automation) ? lastStatus.automation : [];
  const channelSummaries = automation
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const state = String((entry as Record<string, unknown>).state ?? "unknown");
      const cellId = Number((entry as Record<string, unknown>).cellId ?? 0);
      return `CH${index + 1}:${state}${cellId > 0 ? ` Cell-${cellId}` : ""}`;
    })
    .filter(Boolean);
  const automationSummary = channelSummaries.length > 0 ? channelSummaries.join(" | ") : "Snapshot present";
  return resetReason ? `${automationSummary} · reset=${resetReason}` : automationSummary;
}
