import cors from 'cors';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  CHANNEL_START_ORDER,
  expectedBayForCellId,
  orderedBays,
  shortBoardIp,
  sortBoardsForDisplay,
} from './board-layout.js';
import {
  CELL_TEMP_MAX_C,
  CELL_TEMP_MIN_C,
  collectActiveRangeAlerts,
  HEATSINK_TEMP_MAX_C,
  HEATSINK_TEMP_MIN_C,
  type RangeAlert,
  shouldClearRangeAlert,
} from './range-alerts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const PORT = Number(process.env.PORT || 3001);
const DB_PATH = process.env.HUB_DB_PATH
  ? path.resolve(process.env.HUB_DB_PATH)
  : path.join(__dirname, '../data.db');
const CONFIG_PATH = process.env.HUB_CONFIG_PATH
  ? path.resolve(process.env.HUB_CONFIG_PATH)
  : path.join(__dirname, '../config.json');
const SWAP_WEBHOOK_URL = String(process.env.HOME_ASSISTANT_SWAP_WEBHOOK_URL ?? '').trim();
const THERMAL_WEBHOOK_URL = String(
  process.env.HOME_ASSISTANT_THERMAL_WEBHOOK_URL ?? SWAP_WEBHOOK_URL,
).trim();

/** Edge-trigger state: true after we have already fired for the current all-done batch. */
let swapAlertActive = false;
let swapAlertInFlight = false;
/** Keys we have already notified for the current out-of-range episode. */
const notifiedRangeAlertKeys = new Set<string>();
let rangeAlertInFlight = false;
/** Latest active out-of-range alerts, broadcast to the UI. */
let activeRangeAlerts: RangeAlert[] = [];

if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    ip TEXT PRIMARY KEY,
    name TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS cell_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    board_ip TEXT,
    channel INTEGER,
    cell_id INTEGER,
    state TEXT,
    reset_reason TEXT,
    voltage_mv INTEGER,
    current_ma INTEGER,
    ibat_ma INTEGER,
    temp_c REAL,
    capacity_mah REAL
  );

  CREATE TABLE IF NOT EXISTS cell_results (
    cell_id INTEGER PRIMARY KEY,
    board_ip TEXT,
    channel INTEGER,
    capacity_mah REAL,
    resting_voltage_mv INTEGER,
    active_voltage_mv INTEGER DEFAULT 0,
    passed BOOLEAN,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cell_runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    cell_id INTEGER NOT NULL,
    board_ip TEXT NOT NULL,
    channel INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at_ms INTEGER,
    completed_at DATETIME,
    completed_at_ms INTEGER,
    duration_ms INTEGER,
    capacity_mah REAL,
    resting_voltage_mv INTEGER,
    active_voltage_mv INTEGER DEFAULT 0,
    passed INTEGER,
    fault_reason TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_cell_runs_cell ON cell_runs(cell_id);
  CREATE INDEX IF NOT EXISTS idx_cell_runs_started ON cell_runs(started_at_ms DESC);
  CREATE INDEX IF NOT EXISTS idx_cell_runs_status ON cell_runs(status);

  CREATE TABLE IF NOT EXISTS board_last_status (
    board_ip TEXT PRIMARY KEY,
    updated_at_ms INTEGER NOT NULL,
    status_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS board_recovery_state (
    board_ip TEXT PRIMARY KEY,
    blocked INTEGER NOT NULL DEFAULT 0,
    consecutive_recovery_reboots INTEGER NOT NULL DEFAULT 0,
    last_recovery_attempt_ms INTEGER,
    last_recovery_boot_id TEXT,
    last_recovery_decision TEXT,
    updated_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS board_crash_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_ip TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    boot_id TEXT,
    reset_reason TEXT,
    event_type TEXT NOT NULL,
    recovery_attempted INTEGER NOT NULL DEFAULT 0,
    recovery_allowed INTEGER NOT NULL DEFAULT 0,
    details_json TEXT,
    last_status_json TEXT,
    acknowledged_at_ms INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_board_crash_events_board_ts
    ON board_crash_events(board_ip, timestamp_ms DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_board_crash_events_unique_boot
    ON board_crash_events(board_ip, boot_id, event_type);

  CREATE TABLE IF NOT EXISTS cell_ir (
    cell_id INTEGER PRIMARY KEY,
    ir_mohm REAL NOT NULL,
    voltage_v REAL NOT NULL,
    measured_at_ms INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'meter'
  );

  CREATE INDEX IF NOT EXISTS idx_cell_ir_measured ON cell_ir(measured_at_ms DESC);
`);

try {
  db.exec('ALTER TABLE cell_results ADD COLUMN active_voltage_mv INTEGER DEFAULT 0');
} catch {
  // column already exists
}

try {
  db.exec('ALTER TABLE cell_logs ADD COLUMN reset_reason TEXT');
} catch {
  // column already exists
}

try {
  db.exec('ALTER TABLE cell_logs ADD COLUMN run_id INTEGER');
} catch {
  // column already exists
}

try {
  db.exec('ALTER TABLE cell_logs ADD COLUMN ibat_ma INTEGER');
} catch {
  // column already exists
}

db.exec('CREATE INDEX IF NOT EXISTS idx_cell_logs_run ON cell_logs(run_id, id)');

/** Accepted IR / open-circuit voltage windows for automated meter capture. */
const IR_MIN_MOHM = 5.5;
const IR_MAX_MOHM = 7.5;
const METER_VOLTAGE_MIN_V = 3.15;
const METER_VOLTAGE_MAX_V = 3.35;

type MeterStatus = 'ok' | 'ol' | 'settling' | 'invalid';

interface MeterReading {
  status: MeterStatus;
  irMohm: number | null;
  voltageV: number | null;
  resistanceDisplay: string;
  receivedAtMs: number;
}

interface CellIrRow {
  cell_id: number;
  ir_mohm: number;
  voltage_v: number;
  measured_at_ms: number;
  source: string;
}

let latestMeterReading: MeterReading | null = null;

function serializeCellIr(row: CellIrRow) {
  return {
    cellId: row.cell_id,
    irMohm: row.ir_mohm,
    voltageV: row.voltage_v,
    measuredAtMs: row.measured_at_ms,
    source: row.source,
  };
}

function isIrInRange(irMohm: number, voltageV: number): boolean {
  return (
    Number.isFinite(irMohm)
    && Number.isFinite(voltageV)
    && irMohm >= IR_MIN_MOHM
    && irMohm <= IR_MAX_MOHM
    && voltageV >= METER_VOLTAGE_MIN_V
    && voltageV <= METER_VOLTAGE_MAX_V
  );
}

interface Config {
  boards: string[];
  passThresholdMah: number;
  nextCellId: number;
  /** Cell IDs freed by stopped / start_failed attempts, reusable by the matching bay. */
  freeCellIds: number[];
  restoreWindowSeconds: number;
  bootLoopWindowSeconds: number;
  bootLoopThreshold: number;
}

interface RecoveryChannelPlan {
  channel: number;
  restore: boolean;
  state: string;
  stateElapsedMs: number;
  capacityMah: number;
  restingVoltageMv: number;
  activeVoltageMv: number;
  cellId: number;
  dischargeDuty: number;
}

interface CrashSummary {
  boardIp: string;
  totalCrashes: number;
  unresolvedCrashes: number;
  lastCrashAtMs: number | null;
  blocked: boolean;
  consecutiveRecoveryReboots: number;
}

const DEFAULT_CONFIG: Config = {
  boards: [],
  passThresholdMah: 2200,
  nextCellId: 1,
  freeCellIds: [],
  restoreWindowSeconds: 30,
  bootLoopWindowSeconds: 120,
  bootLoopThreshold: 3,
};

let config: Config = { ...DEFAULT_CONFIG };
const BOARDS_SETTING_KEY = 'board_ips';

function normalizeFreeCellIds(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  const ids = input
    .filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b);
  return Array.from(new Set(ids));
}

function normalizeConfig(input: Partial<Config>): Config {
  return {
    boards: Array.isArray(input.boards) ? input.boards : DEFAULT_CONFIG.boards,
    passThresholdMah:
      typeof input.passThresholdMah === 'number' ? input.passThresholdMah : DEFAULT_CONFIG.passThresholdMah,
    nextCellId: typeof input.nextCellId === 'number' ? input.nextCellId : DEFAULT_CONFIG.nextCellId,
    freeCellIds: normalizeFreeCellIds(input.freeCellIds),
    restoreWindowSeconds:
      typeof input.restoreWindowSeconds === 'number'
        ? input.restoreWindowSeconds
        : DEFAULT_CONFIG.restoreWindowSeconds,
    bootLoopWindowSeconds:
      typeof input.bootLoopWindowSeconds === 'number'
        ? input.bootLoopWindowSeconds
        : DEFAULT_CONFIG.bootLoopWindowSeconds,
    bootLoopThreshold:
      typeof input.bootLoopThreshold === 'number' ? input.bootLoopThreshold : DEFAULT_CONFIG.bootLoopThreshold,
  };
}

function loadPersistedBoards(): string[] | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(BOARDS_SETTING_KEY) as
    | { value: string }
    | undefined;
  if (!row) {
    return null;
  }
  try {
    const value = JSON.parse(row.value) as unknown;
    if (!Array.isArray(value)) {
      throw new Error('stored board list is not an array');
    }
    return Array.from(new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ));
  } catch (err) {
    console.error('Failed to load board IPs from database:', err);
    return null;
  }
}

function persistBoards(boards: string[]) {
  db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(BOARDS_SETTING_KEY, JSON.stringify(boards));
}

function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

function setSetting(key: string, value: string) {
  db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function loadConfig() {
  let configFileExists = false;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      configFileExists = true;
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Partial<Config>;
      config = normalizeConfig(raw);
    }
  } catch (err) {
    console.error('Failed to load config:', err);
    config = { ...DEFAULT_CONFIG };
  }

  const persistedBoards = loadPersistedBoards();
  if (persistedBoards !== null) {
    config = { ...config, boards: persistedBoards };
  } else {
    // One-time migration from config.json. From this point on SQLite is the
    // authoritative store because data.db is preserved during deployments.
    persistBoards(config.boards);
  }

  if (!configFileExists) {
    saveConfig();
  }
}

function saveConfig() {
  persistBoards(config.boards);
  const tempPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2));
  fs.renameSync(tempPath, CONFIG_PATH);
}

loadConfig();

const boardStates = new Map<string, any>();
const serverStateStartTimes = new Map<string, number>();
const boardPollFailures = new Map<string, number>();
const BOARD_OFFLINE_FAILURE_THRESHOLD = 3;
let boardPollInFlight = false;

const insertLog = db.prepare(`
  INSERT INTO cell_logs (board_ip, channel, cell_id, run_id, state, reset_reason, voltage_mv, current_ma, ibat_ma, temp_c, capacity_mah)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertRunStmt = db.prepare(`
  INSERT INTO cell_runs (cell_id, board_ip, channel, status, started_at_ms)
  VALUES (?, ?, ?, ?, ?)
`);

const finalizeRunStmt = db.prepare(`
  UPDATE cell_runs
  SET status = ?,
      completed_at = CURRENT_TIMESTAMP,
      completed_at_ms = ?,
      duration_ms = ?,
      capacity_mah = ?,
      resting_voltage_mv = ?,
      active_voltage_mv = ?,
      passed = ?,
      fault_reason = ?
  WHERE run_id = ?
`);

const getRunStmt = db.prepare('SELECT * FROM cell_runs WHERE run_id = ?');

const getRunStageDurations = db.prepare(`
  SELECT
    CASE
      WHEN MIN(CASE WHEN state = 'CHARGE_INITIAL' THEN timestamp END) IS NOT NULL
       AND MIN(CASE WHEN state = 'REST' THEN timestamp END) IS NOT NULL
      THEN CAST(ROUND((
        julianday(MIN(CASE WHEN state = 'REST' THEN timestamp END)) -
        julianday(MIN(CASE WHEN state = 'CHARGE_INITIAL' THEN timestamp END))
      ) * 86400000) AS INTEGER)
      ELSE NULL
    END AS initial_charge_duration_ms,
    CASE
      WHEN MIN(CASE WHEN state = 'DISCHARGE' THEN timestamp END) IS NOT NULL
       AND MIN(CASE WHEN state = 'CHARGE_STORAGE' THEN timestamp END) IS NOT NULL
      THEN CAST(ROUND((
        julianday(MIN(CASE WHEN state = 'CHARGE_STORAGE' THEN timestamp END)) -
        julianday(MIN(CASE WHEN state = 'DISCHARGE' THEN timestamp END))
      ) * 86400000) AS INTEGER)
      ELSE NULL
    END AS discharge_duration_ms,
    COUNT(*) AS sample_count
  FROM cell_logs
  WHERE run_id = ?
`);

const TERMINAL_STATES = new Set(['COMPLETE', 'FAULT']);

function parseSqliteTimestampMs(ts: string | null | undefined): number | null {
  if (!ts) {
    return null;
  }
  const normalized = ts.includes('T') ? ts : ts.replace(' ', 'T');
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = Date.parse(withZone);
  return Number.isFinite(parsed) ? parsed : null;
}

interface RunFinalizeMetrics {
  completedAtMs: number;
  capacityMah?: number | null;
  restingVoltageMv?: number | null;
  activeVoltageMv?: number | null;
  passed?: number | null;
  faultReason?: string | null;
}

function createRun(cellId: number, boardIp: string, channel: number, startedAtMs: number): number {
  const info = insertRunStmt.run(cellId, boardIp, channel, 'running', startedAtMs);
  return Number(info.lastInsertRowid);
}

function finalizeRun(runId: number, status: string, metrics: RunFinalizeMetrics): void {
  const run = getRunStmt.get(runId) as { started_at_ms: number | null } | undefined;
  if (!run) {
    return;
  }
  const startedAtMs = typeof run.started_at_ms === 'number' ? run.started_at_ms : metrics.completedAtMs;
  const durationMs = Math.max(0, metrics.completedAtMs - startedAtMs);
  finalizeRunStmt.run(
    status,
    metrics.completedAtMs,
    durationMs,
    metrics.capacityMah ?? null,
    metrics.restingVoltageMv ?? null,
    metrics.activeVoltageMv ?? 0,
    metrics.passed ?? null,
    metrics.faultReason ?? null,
    runId,
  );
}

const deleteLogsForRunStmt = db.prepare('DELETE FROM cell_logs WHERE run_id = ?');
const deleteRunStmt = db.prepare('DELETE FROM cell_runs WHERE run_id = ?');
const cellIdStillOwnedStmt = db.prepare(`
  SELECT 1 AS ok
  FROM cell_runs
  WHERE cell_id = ?
    AND status IN ('complete', 'fault', 'running')
  LIMIT 1
`);

function compactFreeCellIds(): void {
  config.freeCellIds = normalizeFreeCellIds(config.freeCellIds);
  // Anything at/above the allocation tip is already outside the assigned range.
  config.freeCellIds = config.freeCellIds.filter((id) => id < config.nextCellId);
  // Rewind nextCellId across any free IDs sitting on the tip.
  while (config.nextCellId > 1 && config.freeCellIds.includes(config.nextCellId - 1)) {
    const tip = config.nextCellId - 1;
    config.freeCellIds = config.freeCellIds.filter((id) => id !== tip);
    config.nextCellId = tip;
  }
}

function releaseCellId(cellId: number): void {
  if (!Number.isFinite(cellId) || cellId <= 0) return;
  // Keep IDs that still have a real outcome or an in-flight run.
  if (cellIdStillOwnedStmt.get(cellId)) return;
  // Stale/racy releases after the tip was already rewound must not re-pollute the pool.
  if (cellId >= config.nextCellId) return;
  if (!config.freeCellIds.includes(cellId)) {
    config.freeCellIds.push(cellId);
  }
  compactFreeCellIds();
  saveConfig();
}

/** Drop a stopped / start_failed attempt so it does not consume a cell number. */
function discardIncompleteRun(runId: number): void {
  if (!runId) return;
  const run = getRunStmt.get(runId) as { cell_id: number; status: string } | undefined;
  if (!run) return;
  if (run.status === 'complete' || run.status === 'fault') {
    return;
  }
  const cellId = Number(run.cell_id);
  deleteLogsForRunStmt.run(runId);
  deleteRunStmt.run(runId);
  releaseCellId(cellId);
}

function takeFreeCellIdForBay(boardIp: string, channel: number): number | null {
  for (let index = 0; index < config.freeCellIds.length; index += 1) {
    const cellId = config.freeCellIds[index]!;
    const expected = expectedBayForCellId(cellId, config.boards);
    if (expected && expected.boardIp === boardIp && expected.channel === channel) {
      config.freeCellIds.splice(index, 1);
      saveConfig();
      return cellId;
    }
  }
  return null;
}

type CellAllocationResult =
  | { ok: true; cellId: number }
  | { ok: false; status: number; error: string };

function allocateCellIdForBay(
  boardIp: string,
  channel: number,
  options?: { relaxOrder?: boolean },
): CellAllocationResult {
  const relaxOrder = options?.relaxOrder === true;

  // Prefer a freed ID that belongs on this bay (keeps numbering after a mid-batch stop).
  const recycled = takeFreeCellIdForBay(boardIp, channel);
  if (recycled != null) {
    return { ok: true, cellId: recycled };
  }

  const cellId = config.nextCellId || 1;
  const expected = expectedBayForCellId(cellId, config.boards);
  if (!expected) {
    return { ok: false, status: 500, error: 'No bays configured for cell numbering' };
  }
  if (!relaxOrder && (expected.boardIp !== boardIp || expected.channel !== channel)) {
    const bays = orderedBays(config.boards);
    const thisIndex = bays.findIndex((bay) => bay.boardIp === boardIp && bay.channel === channel);
    const batchStart = cellId - ((cellId - 1) % Math.max(bays.length, 1));
    const suggested = thisIndex >= 0 ? batchStart + thisIndex : null;
    return {
      ok: false,
      status: 409,
      error:
        `Cell #${cellId} belongs on board ${shortBoardIp(expected.boardIp)} ch${expected.channel}. ` +
        `This bay (${shortBoardIp(boardIp)} ch${channel}) is out of order` +
        (suggested != null ? ` (expected cell #${suggested} in this batch)` : '') +
        `. Use Start All when all bays are ready, or retest an existing cell.`,
    };
  }

  config.nextCellId = cellId + 1;
  saveConfig();
  return { ok: true, cellId };
}

/**
 * Live mapping of physical bay -> the run currently attached to it, so poll
 * samples are logged against the correct run and so the mapping survives a hub
 * restart. Keyed by `${boardIp}_${channelIndex}` where channelIndex is 0 or 1.
 */
interface ActiveRun {
  runId: number;
  cellId: number;
  startedAtMs: number;
  lastState: string;
  finalized: boolean;
  /** True when started via API but the board has not yet reported an active state. */
  awaitingBoard: boolean;
}

const activeRuns = new Map<string, ActiveRun>();
const ACTIVE_RUNS_SETTING_KEY = 'active_runs';
/** Grace period for the board to report an active state after an API start. */
const START_GRACE_MS = 30000;

function bayKeyFor(ip: string, channelIndex: number): string {
  return `${ip}_${channelIndex}`;
}

function saveActiveRuns() {
  const serializable: Record<string, ActiveRun> = {};
  for (const [key, value] of activeRuns.entries()) {
    serializable[key] = value;
  }
  try {
    setSetting(ACTIVE_RUNS_SETTING_KEY, JSON.stringify(serializable));
  } catch (err) {
    console.error('Failed to persist active runs:', err);
  }
}

function loadActiveRuns() {
  const raw = getSetting(ACTIVE_RUNS_SETTING_KEY);
  if (!raw) {
    return;
  }
  const parsed = safeParseJson<Record<string, ActiveRun>>(raw);
  if (!parsed) {
    return;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value.runId !== 'number') {
      continue;
    }
    // Only restore runs that still exist and are not already finalized in the DB.
    const run = getRunStmt.get(value.runId) as { status: string } | undefined;
    if (!run) {
      continue;
    }
    activeRuns.set(key, {
      runId: value.runId,
      cellId: Number(value.cellId ?? 0),
      startedAtMs: Number(value.startedAtMs ?? Date.now()),
      lastState: String(value.lastState ?? ''),
      finalized: run.status !== 'running',
      awaitingBoard: Boolean(value.awaitingBoard),
    });
  }
}

function stateRank(state: string): number {
  switch (state) {
    case 'CHARGE_INITIAL':
      return 1;
    case 'REST':
      return 2;
    case 'DISCHARGE':
      return 3;
    case 'CHARGE_STORAGE':
      return 4;
    case 'COMPLETE':
      return 5;
    case 'FAULT':
      return 6;
    default:
      return 0;
  }
}

/**
 * One-time backfill: split legacy `cell_logs` rows (which predate `run_id`) into
 * discrete runs, populate `cell_runs`, and stamp each log with its `run_id`.
 * Idempotent: only touches logs where `run_id IS NULL` and is a no-op afterward.
 * Never deletes data; legacy `cell_results` is preserved and used to enrich the
 * representative completed run per cell.
 */
function migrateLegacyLogsIntoRuns() {
  const pending = db.prepare('SELECT COUNT(*) AS c FROM cell_logs WHERE run_id IS NULL').get() as {
    c: number;
  };
  if (!pending.c) {
    return;
  }

  const GAP_MS = 30 * 60 * 1000;
  const passThreshold = config.passThresholdMah;

  const rows = db
    .prepare(
      `SELECT id, board_ip, channel, cell_id, state, capacity_mah, timestamp
       FROM cell_logs
       WHERE run_id IS NULL
       ORDER BY id ASC`,
    )
    .all() as Array<{
    id: number;
    board_ip: string;
    channel: number;
    cell_id: number;
    state: string;
    capacity_mah: number | null;
    timestamp: string;
  }>;

  const stampLog = db.prepare('UPDATE cell_logs SET run_id = ? WHERE id = ?');

  interface MigratingRun {
    runId: number;
    startMs: number;
    lastMs: number;
    lastState: string;
    lastCapacity: number | null;
  }

  const groups = new Map<string, MigratingRun>();
  let createdRuns = 0;

  const finalizeMigrating = (run: MigratingRun) => {
    const status =
      run.lastState === 'COMPLETE' ? 'complete' : run.lastState === 'FAULT' ? 'fault' : 'stopped';
    const passed =
      status === 'complete' && typeof run.lastCapacity === 'number'
        ? run.lastCapacity >= passThreshold
          ? 1
          : 0
        : null;
    finalizeRunStmt.run(
      status,
      run.lastMs,
      Math.max(0, run.lastMs - run.startMs),
      run.lastCapacity ?? null,
      null,
      0,
      passed,
      null,
      run.runId,
    );
  };

  const runMigration = db.transaction(() => {
    for (const row of rows) {
      const groupKey = `${row.board_ip}|${row.channel}|${row.cell_id}`;
      const tsMs = parseSqliteTimestampMs(row.timestamp) ?? Date.now();
      let current = groups.get(groupKey);

      const isBoundary =
        !current ||
        tsMs - current.lastMs > GAP_MS ||
        (TERMINAL_STATES.has(current.lastState) && !TERMINAL_STATES.has(row.state)) ||
        (row.state === 'CHARGE_INITIAL' && stateRank(current.lastState) > stateRank('CHARGE_INITIAL'));

      if (isBoundary) {
        if (current) {
          finalizeMigrating(current);
        }
        const runId = createRun(row.cell_id, row.board_ip, row.channel, tsMs);
        createdRuns += 1;
        current = {
          runId,
          startMs: tsMs,
          lastMs: tsMs,
          lastState: row.state,
          lastCapacity: row.capacity_mah,
        };
        groups.set(groupKey, current);
      }

      current = current!;
      stampLog.run(current.runId, row.id);
      current.lastMs = tsMs;
      current.lastState = row.state;
      if (typeof row.capacity_mah === 'number') {
        current.lastCapacity = row.capacity_mah;
      }
    }

    for (const run of groups.values()) {
      finalizeMigrating(run);
    }

    // Enrich the most recent completed run per cell with legacy result voltages.
    const legacyResults = db.prepare('SELECT * FROM cell_results').all() as Array<{
      cell_id: number;
      capacity_mah: number | null;
      resting_voltage_mv: number | null;
      active_voltage_mv: number | null;
      passed: number | null;
    }>;
    const enrichStmt = db.prepare(`
      UPDATE cell_runs
      SET resting_voltage_mv = ?, active_voltage_mv = ?, passed = ?, capacity_mah = COALESCE(capacity_mah, ?)
      WHERE run_id = (
        SELECT run_id FROM cell_runs
        WHERE cell_id = ? AND status = 'complete'
        ORDER BY started_at_ms DESC
        LIMIT 1
      )
    `);
    for (const result of legacyResults) {
      enrichStmt.run(
        result.resting_voltage_mv ?? null,
        result.active_voltage_mv ?? 0,
        result.passed ?? null,
        result.capacity_mah ?? null,
        result.cell_id,
      );
    }
  });

  runMigration();
  console.log(`Migrated ${rows.length} legacy log rows into ${createdRuns} runs.`);
}

const upsertLastStatus = db.prepare(`
  INSERT INTO board_last_status (board_ip, updated_at_ms, status_json)
  VALUES (?, ?, ?)
  ON CONFLICT(board_ip) DO UPDATE SET
    updated_at_ms = excluded.updated_at_ms,
    status_json = excluded.status_json
`);

const getLastStatus = db.prepare(`
  SELECT updated_at_ms, status_json
  FROM board_last_status
  WHERE board_ip = ?
`);

const getRecoveryState = db.prepare(`
  SELECT blocked,
         consecutive_recovery_reboots,
         last_recovery_attempt_ms,
         last_recovery_boot_id,
         last_recovery_decision
  FROM board_recovery_state
  WHERE board_ip = ?
`);

const upsertRecoveryState = db.prepare(`
  INSERT INTO board_recovery_state (
    board_ip,
    blocked,
    consecutive_recovery_reboots,
    last_recovery_attempt_ms,
    last_recovery_boot_id,
    last_recovery_decision,
    updated_at_ms
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(board_ip) DO UPDATE SET
    blocked = excluded.blocked,
    consecutive_recovery_reboots = excluded.consecutive_recovery_reboots,
    last_recovery_attempt_ms = excluded.last_recovery_attempt_ms,
    last_recovery_boot_id = excluded.last_recovery_boot_id,
    last_recovery_decision = excluded.last_recovery_decision,
    updated_at_ms = excluded.updated_at_ms
`);

const existingCrashEvent = db.prepare(`
  SELECT id
  FROM board_crash_events
  WHERE board_ip = ? AND boot_id = ? AND event_type = ?
`);

const insertCrashEvent = db.prepare(`
  INSERT INTO board_crash_events (
    board_ip,
    timestamp_ms,
    boot_id,
    reset_reason,
    event_type,
    recovery_attempted,
    recovery_allowed,
    details_json,
    last_status_json
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const listCrashEvents = db.prepare(`
  SELECT id,
         board_ip,
         timestamp_ms,
         boot_id,
         reset_reason,
         event_type,
         recovery_attempted,
         recovery_allowed,
         details_json,
         last_status_json,
         acknowledged_at_ms
  FROM board_crash_events
  WHERE (? = '' OR board_ip = ?)
  ORDER BY timestamp_ms DESC
  LIMIT ?
`);

const clearCrashEventsForBoard = db.prepare(`
  UPDATE board_crash_events
  SET acknowledged_at_ms = ?
  WHERE board_ip = ? AND acknowledged_at_ms IS NULL
`);

const listCrashSummaryRows = db.prepare(`
  SELECT board_ip,
         COUNT(*) AS total_crashes,
         SUM(CASE WHEN acknowledged_at_ms IS NULL THEN 1 ELSE 0 END) AS unresolved_crashes,
         MAX(timestamp_ms) AS last_crash_at_ms
  FROM board_crash_events
  WHERE event_type IN ('crash', 'boot_loop')
  GROUP BY board_ip
`);

function safeParseJson<T>(json: string | null): T | null {
  if (!json) {
    return null;
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function isRecoverableAutomationState(state: unknown): boolean {
  return state === 'CHARGE_INITIAL' || state === 'REST' || state === 'DISCHARGE' || state === 'CHARGE_STORAGE';
}

function isUnexpectedResetReason(reason: string): boolean {
  return (
    reason === 'panic' ||
    reason === 'interrupt watchdog' ||
    reason === 'task watchdog' ||
    reason === 'other watchdog' ||
    reason === 'brownout' ||
    reason === 'unknown'
  );
}

function recordCrashEvent(
  boardIp: string,
  bootId: string,
  resetReason: string,
  eventType: 'crash' | 'boot_loop' | 'reset',
  recoveryAttempted: boolean,
  recoveryAllowed: boolean,
  details: unknown,
  lastStatusJson: string | null,
) {
  if (bootId.length > 0) {
    const existing = existingCrashEvent.get(boardIp, bootId, eventType) as { id: number } | undefined;
    if (existing) {
      return;
    }
  }
  insertCrashEvent.run(
    boardIp,
    Date.now(),
    bootId,
    resetReason,
    eventType,
    recoveryAttempted ? 1 : 0,
    recoveryAllowed ? 1 : 0,
    JSON.stringify(details ?? {}),
    lastStatusJson,
  );
}

function getCrashSummary(boardIp: string): CrashSummary {
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS total_crashes,
             SUM(CASE WHEN acknowledged_at_ms IS NULL THEN 1 ELSE 0 END) AS unresolved_crashes,
             MAX(timestamp_ms) AS last_crash_at_ms
      FROM board_crash_events
      WHERE board_ip = ?
        AND event_type IN ('crash', 'boot_loop')
    `,
    )
    .get(boardIp) as {
    total_crashes: number;
    unresolved_crashes: number | null;
    last_crash_at_ms: number | null;
  };
  const recovery = (getRecoveryState.get(boardIp) as
    | {
        blocked: number;
        consecutive_recovery_reboots: number;
      }
    | undefined) ?? {
    blocked: 0,
    consecutive_recovery_reboots: 0,
  };
  return {
    boardIp,
    totalCrashes: row.total_crashes ?? 0,
    unresolvedCrashes: row.unresolved_crashes ?? 0,
    lastCrashAtMs: row.last_crash_at_ms ?? null,
    blocked: recovery.blocked === 1,
    consecutiveRecoveryReboots: recovery.consecutive_recovery_reboots ?? 0,
  };
}

function getCrashSummaries(): CrashSummary[] {
  const rows = listCrashSummaryRows.all() as Array<{
    board_ip: string;
    total_crashes: number;
    unresolved_crashes: number | null;
    last_crash_at_ms: number | null;
  }>;
  const byIp = new Map<string, CrashSummary>();
  for (const row of rows) {
    const recovery = (getRecoveryState.get(row.board_ip) as
      | {
          blocked: number;
          consecutive_recovery_reboots: number;
        }
      | undefined) ?? { blocked: 0, consecutive_recovery_reboots: 0 };
    byIp.set(row.board_ip, {
      boardIp: row.board_ip,
      totalCrashes: row.total_crashes ?? 0,
      unresolvedCrashes: row.unresolved_crashes ?? 0,
      lastCrashAtMs: row.last_crash_at_ms ?? null,
      blocked: recovery.blocked === 1,
      consecutiveRecoveryReboots: recovery.consecutive_recovery_reboots ?? 0,
    });
  }
  for (const ip of config.boards) {
    if (!byIp.has(ip)) {
      byIp.set(ip, getCrashSummary(ip));
    }
  }
  return Array.from(byIp.values()).sort((a, b) => (b.lastCrashAtMs ?? 0) - (a.lastCrashAtMs ?? 0));
}

function buildRecoveryPlansFromStatus(status: any, nowMs: number): RecoveryChannelPlan[] {
  const plans: RecoveryChannelPlan[] = [];
  const automation = Array.isArray(status?.automation) ? status.automation : [];
  const channels = Array.isArray(status?.channels) ? status.channels : [];
  for (let i = 0; i < 2; i++) {
    const auto = automation[i];
    const ch = channels[i];
    if (!auto || !ch || !isRecoverableAutomationState(auto.state)) {
      continue;
    }
    const serverStartMs =
      typeof auto.serverStateStartMs === 'number'
        ? auto.serverStateStartMs
        : typeof auto.stateStartMs === 'number'
          ? nowMs
          : nowMs;
    const elapsedMs = Math.max(0, nowMs - serverStartMs);
    plans.push({
      channel: i + 1,
      restore: true,
      state: String(auto.state),
      stateElapsedMs: elapsedMs,
      capacityMah: Number(auto.capacityMah ?? 0),
      restingVoltageMv: Number(auto.restingVoltageMv ?? 0),
      activeVoltageMv: Number(auto.activeVoltageMv ?? 0),
      cellId: Number(auto.cellId ?? 0),
      dischargeDuty: Number(ch.dischargeDuty ?? 0),
    });
  }
  return plans;
}

function pruneStateStartTimesForBoard(ip: string, activeKeys: Set<string>) {
  for (const key of serverStateStartTimes.keys()) {
    if (key.startsWith(`${ip}_`) && !activeKeys.has(key)) {
      serverStateStartTimes.delete(key);
    }
  }
}

migrateLegacyLogsIntoRuns();
loadActiveRuns();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/config', (_req, res) => {
  res.json(config);
});

app.post('/api/config', (req, res) => {
  config = normalizeConfig({ ...config, ...req.body });
  saveConfig();
  res.json(config);
});

app.post('/api/integrations/home-assistant/test', async (req, res) => {
  if (req.get('sec-fetch-site') === 'cross-site') {
    res.status(403).json({ ok: false, error: 'Cross-site integration tests are not allowed' });
    return;
  }

  const webhookUrl = THERMAL_WEBHOOK_URL || SWAP_WEBHOOK_URL;
  if (!webhookUrl) {
    res.status(409).json({
      ok: false,
      error: 'Home Assistant webhook is not configured on the hub',
    });
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'integration_test',
        message: 'Battery tester Home Assistant integration test successful.',
        timestamp: new Date().toISOString(),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      res.status(502).json({
        ok: false,
        error: `Home Assistant webhook returned ${response.status}`,
      });
      return;
    }

    res.json({ ok: true, message: 'Test alert sent to Home Assistant' });
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'Home Assistant webhook timed out'
      : 'Failed to reach Home Assistant webhook';
    res.status(502).json({ ok: false, error: message });
  } finally {
    clearTimeout(timeoutId);
  }
});

app.get('/api/state', (_req, res) => {
  res.json(Object.fromEntries(boardStates));
});

app.get('/api/alerts', (_req, res) => {
  res.json({ alerts: activeRangeAlerts });
});

interface RunRow {
  run_id: number;
  cell_id: number;
  board_ip: string;
  channel: number;
  status: string;
  started_at: string | null;
  started_at_ms: number | null;
  completed_at: string | null;
  completed_at_ms: number | null;
  duration_ms: number | null;
  capacity_mah: number | null;
  resting_voltage_mv: number | null;
  active_voltage_mv: number | null;
  passed: number | null;
  fault_reason: string | null;
}

function enrichRun(run: RunRow) {
  const durations = getRunStageDurations.get(run.run_id) as {
    initial_charge_duration_ms: number | null;
    discharge_duration_ms: number | null;
    sample_count: number;
  };
  return {
    ...run,
    initial_charge_duration_ms: durations?.initial_charge_duration_ms ?? null,
    discharge_duration_ms: durations?.discharge_duration_ms ?? null,
    sample_count: durations?.sample_count ?? 0,
  };
}

// Recent finished results for the dashboard summary table.
app.get('/api/results', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM cell_runs
       WHERE status IN ('complete', 'fault', 'stopped')
       ORDER BY COALESCE(completed_at_ms, started_at_ms) DESC
       LIMIT 100`,
    )
    .all() as RunRow[];
  res.json(
    rows.map((run) => {
      const enriched = enrichRun(run);
      return {
        ...enriched,
        // Backward-compatible field name used by the existing dashboard table.
        timestamp: run.completed_at ?? run.started_at,
      };
    }),
  );
});

// Paginated run archive. Each attempt (including retests, faults, and stops) is
// its own row so nothing is overwritten or hidden.
app.get('/api/runs', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const cellId = Number(req.query.cellId ?? 0);
  const filterCell = Number.isFinite(cellId) && cellId > 0;

  const total = (
    filterCell
      ? db.prepare('SELECT COUNT(*) AS c FROM cell_runs WHERE cell_id = ?').get(cellId)
      : db.prepare('SELECT COUNT(*) AS c FROM cell_runs').get()
  ) as { c: number };

  const rows = (
    filterCell
      ? db
          .prepare(
            `SELECT * FROM cell_runs WHERE cell_id = ?
             ORDER BY COALESCE(completed_at_ms, started_at_ms) DESC, run_id DESC
             LIMIT ? OFFSET ?`,
          )
          .all(cellId, limit, offset)
      : db
          .prepare(
            `SELECT * FROM cell_runs
             ORDER BY COALESCE(completed_at_ms, started_at_ms) DESC, run_id DESC
             LIMIT ? OFFSET ?`,
          )
          .all(limit, offset)
  ) as RunRow[];

  res.json({
    runs: rows.map(enrichRun),
    total: total.c,
    limit,
    offset,
  });
});

// Full sample history for a single run.
app.get('/api/runs/:runId', (req, res) => {
  const runId = Number(req.params.runId);
  if (!Number.isFinite(runId) || runId <= 0) {
    res.status(400).json({ error: 'Invalid run id' });
    return;
  }
  const run = getRunStmt.get(runId) as RunRow | undefined;
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const logs = db
    .prepare('SELECT * FROM cell_logs WHERE run_id = ? ORDER BY id ASC')
    .all(runId);
  res.json({ run: enrichRun(run), logs });
});

const getCellIrStmt = db.prepare('SELECT * FROM cell_ir WHERE cell_id = ?');
const upsertCellIrStmt = db.prepare(`
  INSERT INTO cell_ir (cell_id, ir_mohm, voltage_v, measured_at_ms, source)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(cell_id) DO UPDATE SET
    ir_mohm = excluded.ir_mohm,
    voltage_v = excluded.voltage_v,
    measured_at_ms = excluded.measured_at_ms,
    source = excluded.source
`);

app.get('/api/meter', (_req, res) => {
  res.json({
    reading: latestMeterReading,
    limits: {
      irMinMohm: IR_MIN_MOHM,
      irMaxMohm: IR_MAX_MOHM,
      voltageMinV: METER_VOLTAGE_MIN_V,
      voltageMaxV: METER_VOLTAGE_MAX_V,
    },
  });
});

app.post('/api/meter/reading', (req, res) => {
  const result = ingestMeterReading(req.body);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json({ ok: true, reading: result.reading });
});

app.get('/api/ir', (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM cell_ir ORDER BY cell_id ASC')
    .all() as CellIrRow[];
  res.json({
    measurements: rows.map(serializeCellIr),
    limits: {
      irMinMohm: IR_MIN_MOHM,
      irMaxMohm: IR_MAX_MOHM,
      voltageMinV: METER_VOLTAGE_MIN_V,
      voltageMaxV: METER_VOLTAGE_MAX_V,
    },
  });
});

app.get('/api/ir/next-cell', (req, res) => {
  const fromRaw = Number(req.query.from ?? 1);
  const from = Number.isFinite(fromRaw) && fromRaw > 0 ? Math.floor(fromRaw) : 1;

  const row = db
    .prepare(
      `SELECT MIN(cell_id) AS cell_id
       FROM (
         SELECT DISTINCT cell_id AS cell_id FROM cell_runs
         UNION
         SELECT cell_id FROM cell_ir
       )
       WHERE cell_id >= ?
         AND cell_id NOT IN (SELECT cell_id FROM cell_ir)`,
    )
    .get(from) as { cell_id: number | null } | undefined;

  let nextCellId = row?.cell_id ?? null;

  // If every known cell already has IR, offer the next unused ID from config.
  if (nextCellId == null) {
    const candidate = Math.max(from, config.nextCellId || 1);
    const existing = getCellIrStmt.get(candidate) as CellIrRow | undefined;
    nextCellId = existing ? null : candidate;
  }

  const pendingCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT DISTINCT cell_id AS cell_id FROM cell_runs
           UNION
           SELECT cell_id FROM cell_ir
         )
         WHERE cell_id NOT IN (SELECT cell_id FROM cell_ir)`,
      )
      .get() as { c: number }
  ).c;

  res.json({
    nextCellId,
    pendingCount,
    from,
  });
});

app.get('/api/ir/:cellId', (req, res) => {
  const cellId = Number(req.params.cellId);
  if (!Number.isFinite(cellId) || cellId <= 0) {
    res.status(400).json({ error: 'Invalid cell id' });
    return;
  }
  const row = getCellIrStmt.get(cellId) as CellIrRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'No IR measurement for this cell' });
    return;
  }
  res.json(serializeCellIr(row));
});

app.put('/api/ir/:cellId', (req, res) => {
  const cellId = Number(req.params.cellId);
  if (!Number.isFinite(cellId) || cellId <= 0) {
    res.status(400).json({ ok: false, error: 'Invalid cell id' });
    return;
  }

  const irMohm = Number(req.body?.irMohm);
  const voltageV = Number(req.body?.voltageV);
  const sourceRaw = String(req.body?.source ?? 'meter').trim().toLowerCase();
  const source = sourceRaw === 'manual' ? 'manual' : 'meter';
  const skipValidation = req.body?.skipValidation === true || source === 'manual';

  if (!Number.isFinite(irMohm) || !Number.isFinite(voltageV)) {
    res.status(400).json({ ok: false, error: 'irMohm and voltageV are required numbers' });
    return;
  }

  if (!skipValidation && !isIrInRange(irMohm, voltageV)) {
    res.status(400).json({
      ok: false,
      error:
        `Out of range (IR ${IR_MIN_MOHM}-${IR_MAX_MOHM} mΩ, `
        + `V ${METER_VOLTAGE_MIN_V}-${METER_VOLTAGE_MAX_V} V)`,
    });
    return;
  }

  const measuredAtMs = Date.now();
  upsertCellIrStmt.run(cellId, irMohm, voltageV, measuredAtMs, source);
  const row = getCellIrStmt.get(cellId) as CellIrRow;
  res.json({ ok: true, measurement: serializeCellIr(row) });
});

app.get('/api/crashes', (req, res) => {
  const boardIp = typeof req.query.boardIp === 'string' ? req.query.boardIp : '';
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
  const rows = listCrashEvents.all(boardIp, boardIp, limit) as Array<{
    id: number;
    board_ip: string;
    timestamp_ms: number;
    boot_id: string | null;
    reset_reason: string | null;
    event_type: string;
    recovery_attempted: number;
    recovery_allowed: number;
    details_json: string | null;
    last_status_json: string | null;
    acknowledged_at_ms: number | null;
  }>;
  res.json({
    summaries: getCrashSummaries(),
    events: rows.map((row) => ({
      id: row.id,
      boardIp: row.board_ip,
      timestampMs: row.timestamp_ms,
      bootId: row.boot_id,
      resetReason: row.reset_reason,
      eventType: row.event_type,
      recoveryAttempted: row.recovery_attempted === 1,
      recoveryAllowed: row.recovery_allowed === 1,
      details: safeParseJson<Record<string, unknown>>(row.details_json) ?? {},
      lastStatus: safeParseJson<Record<string, unknown>>(row.last_status_json),
      acknowledgedAtMs: row.acknowledged_at_ms,
    })),
  });
});

app.post('/api/crashes/:ip/clear', (req, res) => {
  const ip = req.params.ip;
  const now = Date.now();
  clearCrashEventsForBoard.run(now, ip);
  upsertRecoveryState.run(ip, 0, 0, null, null, 'cleared', now);

  const prev = boardStates.get(ip) ?? {};
  boardStates.set(ip, { ...prev, crash: getCrashSummary(ip) });
  broadcastState();

  res.json({ ok: true, crash: getCrashSummary(ip) });
});

const clearHistoricalData = db.transaction(() => {
  const deleted = {
    logs: db.prepare('DELETE FROM cell_logs').run().changes,
    results: db.prepare('DELETE FROM cell_results').run().changes,
    runs: db.prepare('DELETE FROM cell_runs').run().changes,
    ir: db.prepare('DELETE FROM cell_ir').run().changes,
    crashes: db.prepare('DELETE FROM board_crash_events').run().changes,
    recoveryStates: db.prepare('DELETE FROM board_recovery_state').run().changes,
    statusSnapshots: db.prepare('DELETE FROM board_last_status').run().changes,
  };
  db.prepare('DELETE FROM settings WHERE key = ?').run(ACTIVE_RUNS_SETTING_KEY);
  return deleted;
});

app.post('/api/data/clear', (req, res) => {
  if (req.get('sec-fetch-site') === 'cross-site') {
    res.status(403).json({ ok: false, error: 'Cross-site data deletion is not allowed' });
    return;
  }

  if (req.body?.confirmation !== 'CLEAR ALL DATA') {
    res.status(400).json({ ok: false, error: 'Type CLEAR ALL DATA to confirm deletion' });
    return;
  }

  const activeBoard = Array.from(boardStates.entries()).find(([, status]) => {
    const automationActive = Array.isArray(status?.automation)
      && status.automation.some((entry: { state?: string }) => entry?.state && entry.state !== 'IDLE');
    const outputActive = Array.isArray(status?.channels)
      && status.channels.some(
        (channel: { chargeEnabled?: boolean; dischargeDuty?: number }) =>
          channel?.chargeEnabled || Number(channel?.dischargeDuty ?? 0) > 0,
      );
    return automationActive || outputActive;
  });

  if (activeBoard) {
    res.status(409).json({
      ok: false,
      error: `Stop all tests and outputs before clearing data (${activeBoard[0]} is active)`,
    });
    return;
  }

  try {
    const deleted = clearHistoricalData();
    activeRuns.clear();
    const resetNextCellId = req.body?.resetNextCellId !== false;
    if (resetNextCellId) {
      config.nextCellId = 1;
      config.freeCellIds = [];
      saveConfig();
    }

    for (const [ip, status] of boardStates) {
      boardStates.set(ip, { ...status, crash: getCrashSummary(ip) });
    }
    broadcastState();

    res.json({
      ok: true,
      deleted,
      nextCellId: config.nextCellId,
    });
  } catch (error) {
    console.error('Failed to clear historical data:', error);
    res.status(500).json({ ok: false, error: 'Failed to clear historical data' });
  }
});

app.post('/api/next-cell-id', (_req, res) => {
  const id = config.nextCellId || 1;
  config.nextCellId = id + 1;
  saveConfig();
  res.json({ cellId: id });
});

async function callBoard(
  ip: string,
  boardPath: string,
  method: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    const init: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    };
    if (method !== 'GET' && method !== 'HEAD') {
      init.body = JSON.stringify(body ?? {});
    }
    const response = await fetch(`http://${ip}${boardPath}`, init);
    let data: any = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 502, data: { error: 'Failed to reach board' } };
  } finally {
    clearTimeout(timeoutId);
  }
}

type StartMode = 'new' | 'retest';
type BayCommandResult =
  | { ok: true; boardIp: string; channel: number; runId: number; cellId: number }
  | {
      ok: false;
      boardIp: string;
      channel: number;
      status: number;
      error: string;
      runId?: number;
      cellId?: number;
    };

let bulkOperationInFlight = false;
const BULK_START_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Atomic automation start / retest. A brand new cell number is only allocated
// for a fresh cell; a retest reuses the existing number. Incomplete stops and
// start failures discard the run so the cell number can be reused.
async function startAutomationForBay(
  boardIp: string,
  channel: number,
  mode: StartMode,
  requestedCellId: number,
  options?: { relaxOrder?: boolean },
): Promise<BayCommandResult> {
  if (!boardIp || !config.boards.includes(boardIp)) {
    return { ok: false, boardIp, channel, status: 400, error: 'Unknown board' };
  }
  if (channel !== 1 && channel !== 2) {
    return { ok: false, boardIp, channel, status: 400, error: 'Invalid channel' };
  }
  if (mode === 'retest' && (!Number.isFinite(requestedCellId) || requestedCellId <= 0)) {
    return {
      ok: false,
      boardIp,
      channel,
      status: 400,
      error: 'Retest requires a valid cell number',
    };
  }

  const channelIndex = channel - 1;
  const bayKey = bayKeyFor(boardIp, channelIndex);
  const status = boardStates.get(boardIp);

  if (!status?.online) {
    return { ok: false, boardIp, channel, status: 409, error: 'Board is offline' };
  }

  const liveChannel = status.channels?.[channelIndex];
  const liveAuto = status.automation?.[channelIndex];
  if (!liveChannel?.cellPresent) {
    return { ok: false, boardIp, channel, status: 409, error: 'No cell detected in this bay' };
  }

  const activeState = String(liveAuto?.state ?? 'IDLE');
  const isRunningState = activeState !== 'IDLE' && activeState !== 'COMPLETE' && activeState !== 'FAULT';
  if (isRunningState) {
    return {
      ok: false,
      boardIp,
      channel,
      status: 409,
      error: 'A test is already running in this bay',
    };
  }

  // Reset a finished bay (COMPLETE/FAULT) or a stale mapping before starting.
  const existing = activeRuns.get(bayKey);
  if (existing && !existing.finalized) {
    discardIncompleteRun(existing.runId);
  }
  activeRuns.delete(bayKey);
  saveActiveRuns();

  if (activeState === 'COMPLETE' || activeState === 'FAULT') {
    // Return the board to IDLE so it accepts a new cycle.
    await callBoard(boardIp, `/api/channel/${channel}/auto/stop`, 'POST');
  }

  let cellId: number;
  if (mode === 'retest') {
    cellId = requestedCellId;
  } else {
    const allocation = allocateCellIdForBay(boardIp, channel, {
      relaxOrder: options?.relaxOrder === true,
    });
    if (!allocation.ok) {
      return {
        ok: false,
        boardIp,
        channel,
        status: allocation.status,
        error: allocation.error,
      };
    }
    cellId = allocation.cellId;
  }

  const nowMs = Date.now();
  const runId = createRun(cellId, boardIp, channel, nowMs);

  const startResult = await callBoard(boardIp, `/api/channel/${channel}/auto/start`, 'POST', { cellId });
  if (!startResult.ok) {
    discardIncompleteRun(runId);
    const message =
      (startResult.data && typeof startResult.data === 'object' && startResult.data.error) ||
      'Board rejected the start command';
    return {
      ok: false,
      boardIp,
      channel,
      status: startResult.status >= 400 ? startResult.status : 502,
      error: String(message),
    };
  }

  activeRuns.set(bayKey, {
    runId,
    cellId,
    startedAtMs: nowMs,
    lastState: 'IDLE',
    finalized: false,
    awaitingBoard: true,
  });
  saveActiveRuns();

  return { ok: true, boardIp, channel, runId, cellId };
}

app.post('/api/automation/start', async (req, res) => {
  if (bulkOperationInFlight) {
    res.status(409).json({ ok: false, error: 'A fleet operation is already in progress' });
    return;
  }

  const boardIp = String(req.body?.boardIp ?? '').trim();
  const channel = Number(req.body?.channel);
  const mode: StartMode = req.body?.mode === 'retest' ? 'retest' : 'new';
  const requestedCellId = Number(req.body?.cellId ?? 0);
  const result = await startAutomationForBay(boardIp, channel, mode, requestedCellId);

  if (!result.ok) {
    res.status(result.status).json(result);
    return;
  }
  res.json(result);
});

app.post('/api/automation/start-all', async (req, res) => {
  if (bulkOperationInFlight) {
    res.status(409).json({ ok: false, error: 'A fleet operation is already in progress' });
    return;
  }

  const force = req.body?.force === true;

  // Left → right on the bench: board order, then Channel B then Channel A.
  const fleetBays = orderedBays(config.boards);
  const readyBays: Array<{ boardIp: string; channel: number }> = [];
  let skipped = 0;
  for (const bay of fleetBays) {
    const status = boardStates.get(bay.boardIp);
    const channelIndex = bay.channel - 1;
    const liveChannel = status?.channels?.[channelIndex];
    const auto = status?.automation?.[channelIndex];
    if (status?.online && liveChannel?.cellPresent && auto?.state === 'IDLE') {
      readyBays.push(bay);
    } else {
      skipped += 1;
    }
  }

  const expectedBays = fleetBays.length;
  if (!force && expectedBays > 0 && readyBays.length !== expectedBays) {
    res.status(409).json({
      ok: false,
      error:
        `Only ${readyBays.length} of ${expectedBays} bays are ready. ` +
        `Starting a partial fleet breaks left→right cell numbering. ` +
        `Load every bay (or confirm force start).`,
      code: 'INCOMPLETE_FLEET',
      ready: readyBays.length,
      expected: expectedBays,
      skipped,
    });
    return;
  }

  // Without force, the next cell must belong on the first ready bay (batch alignment).
  if (!force && readyBays.length > 0) {
    const first = readyBays[0]!;
    const probeId = config.freeCellIds.find((cellId) => {
      const expected = expectedBayForCellId(cellId, config.boards);
      return expected?.boardIp === first.boardIp && expected.channel === first.channel;
    }) ?? (config.nextCellId || 1);
    const expected = expectedBayForCellId(probeId, config.boards);
    if (!expected || expected.boardIp !== first.boardIp || expected.channel !== first.channel) {
      res.status(409).json({
        ok: false,
        error:
          `Cell numbering is misaligned for Start All (next cell #${probeId} ` +
          `belongs on ${expected ? `${shortBoardIp(expected.boardIp)} ch${expected.channel}` : 'an unknown bay'}). ` +
          `Fix free/next cell IDs before starting a new batch.`,
        code: 'CELL_ORDER_MISALIGNED',
        nextCellId: config.nextCellId,
        freeCellIds: config.freeCellIds,
      });
      return;
    }
  }

  bulkOperationInFlight = true;
  const results: BayCommandResult[] = [];
  try {
    for (let index = 0; index < readyBays.length; index += 1) {
      const bay = readyBays[index]!;
      results.push(
        await startAutomationForBay(bay.boardIp, bay.channel, 'new', 0, {
          // Force only bypasses the "all bays ready" gate; numbering still prefers
          // recycled IDs for the matching bay, then sequential nextCellId.
          relaxOrder: force,
        }),
      );
      if (index < readyBays.length - 1) {
        await sleep(BULK_START_DELAY_MS);
      }
    }
  } finally {
    bulkOperationInFlight = false;
  }

  const succeeded = results.filter((result) => result.ok).length;
  res.json({
    ok: succeeded === results.length,
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    skipped,
    delayMs: BULK_START_DELAY_MS,
    forced: force,
    results,
  });
});

type ResetBayResult =
  | { ok: true; boardIp: string; channel: number }
  | { ok: false; boardIp: string; channel: number; status: number; error: string };

async function resetAutomationBay(boardIp: string, channel: number): Promise<ResetBayResult> {
  if (!boardIp || !config.boards.includes(boardIp)) {
    return { ok: false, boardIp, channel, status: 400, error: 'Unknown board' };
  }
  if (channel !== 1 && channel !== 2) {
    return { ok: false, boardIp, channel, status: 400, error: 'Invalid channel' };
  }

  const stopResult = await callBoard(boardIp, `/api/channel/${channel}/auto/stop`, 'POST');
  if (!stopResult.ok) {
    const message =
      (stopResult.data && typeof stopResult.data === 'object' && stopResult.data.error) ||
      'Board rejected the stop command';
    return {
      ok: false,
      boardIp,
      channel,
      status: stopResult.status >= 400 ? stopResult.status : 502,
      error: String(message),
    };
  }

  const bayKey = bayKeyFor(boardIp, channel - 1);
  const active = activeRuns.get(bayKey);
  if (active && !active.finalized) {
    // Incomplete stops must not keep a cell number — reclaim for the same bay.
    discardIncompleteRun(active.runId);
  }
  activeRuns.delete(bayKey);
  saveActiveRuns();

  return { ok: true, boardIp, channel };
}

// Stop / reset a bay. Finalizes the active run so its true elapsed time and
// status are preserved.
app.post('/api/automation/stop', async (req, res) => {
  if (bulkOperationInFlight) {
    res.status(409).json({ ok: false, error: 'A fleet operation is already in progress' });
    return;
  }

  const boardIp = String(req.body?.boardIp ?? '').trim();
  const channel = Number(req.body?.channel);
  const result = await resetAutomationBay(boardIp, channel);
  if (!result.ok) {
    res.status(result.status).json(result);
    return;
  }
  res.json(result);
});

app.post('/api/automation/reset-all', async (_req, res) => {
  if (bulkOperationInFlight) {
    res.status(409).json({ ok: false, error: 'A fleet operation is already in progress' });
    return;
  }

  // Same left → right bay order as Start All (board order, then B then A).
  const finishedBays: Array<{ boardIp: string; channel: number }> = [];
  let skipped = 0;
  for (const boardIp of sortBoardsForDisplay(config.boards)) {
    const status = boardStates.get(boardIp);
    for (const channel of CHANNEL_START_ORDER) {
      const channelIndex = channel - 1;
      const state = status?.automation?.[channelIndex]?.state;
      if (status?.online && (state === 'COMPLETE' || state === 'FAULT')) {
        finishedBays.push({ boardIp, channel });
      } else {
        skipped += 1;
      }
    }
  }

  bulkOperationInFlight = true;
  let results: ResetBayResult[] = [];
  try {
    results = await Promise.all(
      finishedBays.map((bay) => resetAutomationBay(bay.boardIp, bay.channel)),
    );
  } finally {
    bulkOperationInFlight = false;
  }

  const succeeded = results.filter((result) => result.ok).length;
  res.json({
    ok: succeeded === results.length,
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    skipped,
    delayMs: 0,
    results,
  });
});

app.post('/api/boards/recovery-query', (req, res) => {
  const boardIp = String(req.body?.boardIp ?? '').trim();
  const bootId = String(req.body?.bootId ?? '').trim();
  const resetReason = String(req.body?.resetReason ?? 'unknown').trim().toLowerCase();
  const uptimeMs = Number(req.body?.uptimeMs ?? 0);
  const chemistry = String(req.body?.chemistry ?? '').trim();

  if (!boardIp) {
    res.status(400).json({ ok: false, error: 'missing boardIp' });
    return;
  }

  const now = Date.now();
  const lastStatusRow = getLastStatus.get(boardIp) as { updated_at_ms: number; status_json: string } | undefined;
  const recoveryRow = (getRecoveryState.get(boardIp) as
    | {
        blocked: number;
        consecutive_recovery_reboots: number;
        last_recovery_attempt_ms: number | null;
        last_recovery_boot_id: string | null;
        last_recovery_decision: string | null;
      }
    | undefined) ?? {
    blocked: 0,
    consecutive_recovery_reboots: 0,
    last_recovery_attempt_ms: null,
    last_recovery_boot_id: null,
    last_recovery_decision: null,
  };

  const bootLoopWindowMs = config.bootLoopWindowSeconds * 1000;
  let consecutiveRecoveryReboots = recoveryRow.consecutive_recovery_reboots ?? 0;
  if (
    recoveryRow.last_recovery_decision === 'restore' &&
    recoveryRow.last_recovery_attempt_ms &&
    now - recoveryRow.last_recovery_attempt_ms <= bootLoopWindowMs &&
    recoveryRow.last_recovery_boot_id &&
    recoveryRow.last_recovery_boot_id !== bootId
  ) {
    consecutiveRecoveryReboots += 1;
  } else if (
    recoveryRow.last_recovery_attempt_ms &&
    now - recoveryRow.last_recovery_attempt_ms > bootLoopWindowMs
  ) {
    consecutiveRecoveryReboots = 0;
  }

  let blocked = recoveryRow.blocked === 1;
  if (consecutiveRecoveryReboots >= config.bootLoopThreshold) {
    blocked = true;
  }

  const unexpectedReset = isUnexpectedResetReason(resetReason);
  recordCrashEvent(
    boardIp,
    bootId,
    resetReason,
    'reset',
    false,
    false,
    {
      source: 'recovery-query',
      uptimeMs,
      unexpectedReset,
    },
    lastStatusRow?.status_json ?? null,
  );
  if (unexpectedReset) {
    recordCrashEvent(
      boardIp,
      bootId,
      resetReason,
      'crash',
      true,
      false,
      {
        source: 'recovery-query',
        uptimeMs,
        blocked,
        consecutiveRecoveryReboots,
      },
      lastStatusRow?.status_json ?? null,
    );
  }

  if (blocked) {
    recordCrashEvent(
      boardIp,
      bootId,
      resetReason,
      'boot_loop',
      true,
      false,
      {
        source: 'recovery-query',
        reason: 'boot-loop-block',
        consecutiveRecoveryReboots,
      },
      lastStatusRow?.status_json ?? null,
    );
    upsertRecoveryState.run(
      boardIp,
      1,
      consecutiveRecoveryReboots,
      now,
      bootId,
      'blocked',
      now,
    );
    res.json({
      ok: true,
      recover: false,
      reason: 'boot-loop-detected',
      channels: [],
      crash: getCrashSummary(boardIp),
    });
    return;
  }

  if (!unexpectedReset) {
    upsertRecoveryState.run(
      boardIp,
      0,
      consecutiveRecoveryReboots,
      now,
      bootId,
      'skip-non-crash-reset',
      now,
    );
    res.json({
      ok: true,
      recover: false,
      reason: 'non-crash-reset',
      channels: [],
      crash: getCrashSummary(boardIp),
    });
    return;
  }

  if (!lastStatusRow) {
    upsertRecoveryState.run(boardIp, 0, consecutiveRecoveryReboots, now, bootId, 'skip-no-history', now);
    res.json({
      ok: true,
      recover: false,
      reason: 'no-status-history',
      channels: [],
      crash: getCrashSummary(boardIp),
    });
    return;
  }

  const statusAgeMs = now - lastStatusRow.updated_at_ms;
  if (statusAgeMs > config.restoreWindowSeconds * 1000) {
    upsertRecoveryState.run(boardIp, 0, consecutiveRecoveryReboots, now, bootId, 'skip-stale', now);
    res.json({
      ok: true,
      recover: false,
      reason: `stale-status-${Math.floor(statusAgeMs / 1000)}s`,
      channels: [],
      crash: getCrashSummary(boardIp),
    });
    return;
  }

  const lastStatus = safeParseJson<any>(lastStatusRow.status_json);
  const previousChemistry = String(lastStatus?.chemistry?.id ?? '');
  if (!chemistry || chemistry !== previousChemistry) {
    upsertRecoveryState.run(boardIp, 0, consecutiveRecoveryReboots, now, bootId, 'skip-chemistry-mismatch', now);
    res.json({
      ok: true,
      recover: false,
      reason: 'chemistry-mismatch',
      channels: [],
      crash: getCrashSummary(boardIp),
    });
    return;
  }
  const channels = buildRecoveryPlansFromStatus(lastStatus, now);
  if (channels.length === 0) {
    upsertRecoveryState.run(boardIp, 0, consecutiveRecoveryReboots, now, bootId, 'skip-idle', now);
    res.json({
      ok: true,
      recover: false,
      reason: 'no-active-automation',
      channels: [],
      crash: getCrashSummary(boardIp),
    });
    return;
  }

  upsertRecoveryState.run(boardIp, 0, consecutiveRecoveryReboots, now, bootId, 'restore', now);
  res.json({
    ok: true,
    recover: true,
    reason: 'fresh-active-automation',
    restoreWindowSeconds: config.restoreWindowSeconds,
    channels,
    crash: getCrashSummary(boardIp),
  });
});

app.use('/api/proxy/:ip', async (req, res) => {
  const { ip } = req.params;
  const upstreamPath = req.path;
  try {
    const init: RequestInit = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = JSON.stringify(req.body ?? {});
    }
    const response = await fetch(`http://${ip}${upstreamPath}`, {
      ...init,
    });
    const data = (await response.json()) as unknown;
    res.status(response.status).json(data);
  } catch {
    res.status(502).json({ ok: false, error: 'Failed to reach board' });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcastState() {
  const payload = JSON.stringify({
    type: 'state',
    data: Object.fromEntries(boardStates),
    alerts: activeRangeAlerts,
  });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function broadcastMeter() {
  const payload = JSON.stringify({
    type: 'meter',
    data: latestMeterReading,
  });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function ingestMeterReading(body: unknown):
  | { ok: true; reading: MeterReading }
  | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid meter reading payload' };
  }
  const input = body as Record<string, unknown>;
  const statusRaw = String(input.status ?? '').trim().toLowerCase();
  const allowed: MeterStatus[] = ['ok', 'ol', 'settling', 'invalid'];
  if (!allowed.includes(statusRaw as MeterStatus)) {
    return { ok: false, error: 'status must be ok, ol, settling, or invalid' };
  }

  const status = statusRaw as MeterStatus;
  const resistanceDisplay =
    String(input.resistanceDisplay ?? '').trim() || status.toUpperCase();
  let irMohm: number | null = null;
  let voltageV: number | null = null;

  if (input.irMohm != null && input.irMohm !== '') {
    irMohm = Number(input.irMohm);
    if (!Number.isFinite(irMohm)) {
      return { ok: false, error: 'irMohm must be a number' };
    }
  }

  if (input.voltageV != null && input.voltageV !== '') {
    voltageV = Number(input.voltageV);
    if (!Number.isFinite(voltageV)) {
      return { ok: false, error: 'voltageV must be a number' };
    }
  }

  if (status === 'ok' && (irMohm == null || voltageV == null)) {
    return { ok: false, error: 'ok readings require irMohm and voltageV' };
  }

  latestMeterReading = {
    status,
    irMohm,
    voltageV,
    resistanceDisplay,
    receivedAtMs: Date.now(),
  };
  broadcastMeter();
  return { ok: true, reading: latestMeterReading };
}

wss.on('connection', (socket) => {
  if (latestMeterReading) {
    socket.send(JSON.stringify({ type: 'meter', data: latestMeterReading }));
  }

  socket.on('message', (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') {
      return;
    }
    const typed = msg as { type?: string };
    if (typed.type !== 'meter_reading') {
      return;
    }
    ingestMeterReading(msg);
  });
});

interface CompletedCellSummary {
  boardIp: string;
  channel: number;
  cellId: number;
  capacityMah: number;
}

function isBayFinished(state: string | undefined): boolean {
  return state === 'COMPLETE' || state === 'FAULT';
}

function listOccupiedBayProgress(): {
  occupiedCount: number;
  finishedCount: number;
  completed: CompletedCellSummary[];
  allFinished: boolean;
} {
  const completed: CompletedCellSummary[] = [];
  let occupiedCount = 0;
  let finishedCount = 0;

  for (const boardIp of sortBoardsForDisplay(config.boards)) {
    const status = boardStates.get(boardIp);
    if (!status?.online || !Array.isArray(status.automation) || !Array.isArray(status.channels)) {
      continue;
    }
    for (const channel of CHANNEL_START_ORDER) {
      const channelIndex = channel - 1;
      const liveChannel = status.channels[channelIndex];
      const auto = status.automation[channelIndex];
      if (!liveChannel?.cellPresent) {
        continue;
      }
      occupiedCount += 1;
      if (!isBayFinished(auto?.state)) {
        continue;
      }
      finishedCount += 1;
      if (auto?.state === 'COMPLETE') {
        completed.push({
          boardIp,
          channel: Number(liveChannel.channel ?? channel),
          cellId: Number(auto.cellId ?? 0),
          capacityMah: Number(auto.capacityMah ?? 0),
        });
      }
    }
  }

  return {
    occupiedCount,
    finishedCount,
    completed,
    allFinished: occupiedCount > 0 && finishedCount === occupiedCount,
  };
}

async function maybeNotifyHomeAssistantSwapReady() {
  if (!SWAP_WEBHOOK_URL) {
    return;
  }

  const { occupiedCount, finishedCount, completed, allFinished } = listOccupiedBayProgress();

  if (!allFinished) {
    swapAlertActive = false;
    return;
  }

  if (swapAlertActive || swapAlertInFlight) {
    return;
  }

  swapAlertActive = true;
  swapAlertInFlight = true;
  const completeCount = completed.length;
  const message =
    occupiedCount === 1
      ? 'Battery tester: all cells finished (1). Time to swap cells.'
      : `Battery tester: all ${occupiedCount} cells finished. Time to swap cells.`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(SWAP_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'cells_ready_for_swap',
        completeCount,
        finishedCount,
        occupiedCount,
        allFinished: true,
        message,
        cells: completed,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      swapAlertActive = false;
      console.error(
        `Home Assistant swap webhook failed (${response.status} ${response.statusText})`,
      );
      return;
    }

    console.log(
      `Home Assistant swap alert sent (all ${occupiedCount} occupied bays finished; ${completeCount} COMPLETE)`,
    );
  } catch (error) {
    swapAlertActive = false;
    console.error('Home Assistant swap webhook error:', error);
  } finally {
    swapAlertInFlight = false;
  }
}

function refreshActiveRangeAlerts() {
  activeRangeAlerts = collectActiveRangeAlerts(boardStates);

  for (const key of [...notifiedRangeAlertKeys]) {
    if (shouldClearRangeAlert(key, boardStates)) {
      notifiedRangeAlertKeys.delete(key);
    }
  }
}

async function maybeNotifyHomeAssistantRangeAlerts() {
  refreshActiveRangeAlerts();

  const newAlerts = activeRangeAlerts.filter(
    (alert) => !notifiedRangeAlertKeys.has(alert.key),
  );
  if (newAlerts.length === 0 || !THERMAL_WEBHOOK_URL || rangeAlertInFlight) {
    return;
  }

  for (const alert of newAlerts) {
    notifiedRangeAlertKeys.add(alert.key);
  }

  rangeAlertInFlight = true;
  const message = `Battery tester out-of-range warning: ${newAlerts
    .map((alert) => alert.message)
    .join('; ')}.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(THERMAL_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'telemetry_out_of_range',
        message,
        alerts: newAlerts.map(({ key: _key, ...alert }) => alert),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    console.log(`Home Assistant range alert sent: ${message}`);
  } catch (error) {
    // Allow retry on the next poll if delivery failed.
    for (const alert of newAlerts) {
      notifiedRangeAlertKeys.delete(alert.key);
    }
    console.error('Home Assistant range webhook error:', error);
  } finally {
    clearTimeout(timeoutId);
    rangeAlertInFlight = false;
  }
}

function markBoardPollFailure(ip: string) {
  const failureCount = (boardPollFailures.get(ip) ?? 0) + 1;
  boardPollFailures.set(ip, failureCount);
  const prev = boardStates.get(ip);
  const shouldMarkOffline = !prev?.online || failureCount >= BOARD_OFFLINE_FAILURE_THRESHOLD;
  boardStates.set(ip, {
    ...(prev ?? {}),
    online: shouldMarkOffline ? false : true,
    lastSeen: prev?.lastSeen,
    crash: getCrashSummary(ip),
  });
}

async function pollBoard(ip: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
      const response = await fetch(`http://${ip}/api/status`, {
        signal: controller.signal,
        cache: 'no-store',
      });

      if (!response.ok) {
        markBoardPollFailure(ip);
        return;
      }

      const now = Date.now();
      const data = (await response.json()) as any;
      boardPollFailures.set(ip, 0);
      const prevState = boardStates.get(ip);
      const resetReason = String(data?.system?.resetReason ?? 'unknown').toLowerCase();
      const activeStateKeys = new Set<string>();

      if (Array.isArray(data?.channels) && Array.isArray(data?.automation) && Array.isArray(data?.ina) && Array.isArray(data?.thermistors)) {
        for (let i = 0; i < 2; i++) {
          const ch = data.channels[i];
          const auto = data.automation[i];
          const ina = data.ina[i];
          const therm = i === 0 ? data.thermistors[2] : data.thermistors[0];
          if (!ch || !auto || !ina || !therm) {
            continue;
          }

          const stateKey = `${ip}_${i}_${auto.cellId}_${auto.state}`;
          if (isRecoverableAutomationState(auto.state)) {
            activeStateKeys.add(stateKey);
            if (!serverStateStartTimes.has(stateKey)) {
              serverStateStartTimes.set(stateKey, now);
            }
            auto.serverStateStartMs = serverStateStartTimes.get(stateKey);
          } else {
            auto.serverStateStartMs = null;
          }

          const bayKey = bayKeyFor(ip, i);
          const prevAuto = prevState?.automation?.[i];
          const prevPolledState = String(prevAuto?.state ?? '');

          if (auto.state === 'IDLE') {
            const active = activeRuns.get(bayKey);
            if (active) {
              if (active.awaitingBoard) {
                // Board never picked up the automation we asked it to start.
                if (now - active.startedAtMs > START_GRACE_MS) {
                  discardIncompleteRun(active.runId);
                  activeRuns.delete(bayKey);
                  saveActiveRuns();
                }
              } else if (!active.finalized) {
                // Incomplete stop — drop the attempt so the cell number can be reused.
                discardIncompleteRun(active.runId);
                activeRuns.delete(bayKey);
                saveActiveRuns();
              } else {
                activeRuns.delete(bayKey);
                saveActiveRuns();
              }
            }
          } else {
            let active = activeRuns.get(bayKey);
            const isTerminal = TERMINAL_STATES.has(auto.state);
            const needsNewRun =
              !active ||
              active.cellId !== auto.cellId ||
              (active.finalized && !isTerminal);

            if (needsNewRun) {
              if (isTerminal) {
                // Board is already finished (e.g. hub restarted while COMPLETE).
                // Do not invent a new run — just remember the bay so we stop
                // re-evaluating until it returns to IDLE or starts a new cycle.
                activeRuns.set(bayKey, {
                  runId: active?.runId ?? 0,
                  cellId: auto.cellId,
                  startedAtMs: active?.startedAtMs ?? now,
                  lastState: auto.state,
                  finalized: true,
                  awaitingBoard: false,
                });
                saveActiveRuns();
                continue;
              }

              if (active && !active.finalized && active.cellId !== auto.cellId) {
                // A different cell appeared without us seeing the previous one finish.
                discardIncompleteRun(active.runId);
              }
              active = {
                runId: createRun(auto.cellId, ip, i + 1, now),
                cellId: auto.cellId,
                startedAtMs: now,
                lastState: auto.state,
                finalized: false,
                awaitingBoard: false,
              };
              activeRuns.set(bayKey, active);
              saveActiveRuns();
            }

            // After the branches above, active is always defined for non-terminal
            // paths; terminal-without-run already continued.
            if (!active) {
              continue;
            }

            if (active.awaitingBoard) {
              active.awaitingBoard = false;
              saveActiveRuns();
            }

            // Still sitting in COMPLETE/FAULT for a run we already finalized.
            if (active.finalized) {
              active.lastState = auto.state;
              continue;
            }

            const isStationaryTerminal =
              isTerminal && prevPolledState === auto.state;
            if (!isStationaryTerminal) {
              insertLog.run(
                ip,
                i + 1,
                auto.cellId,
                active.runId,
                auto.state,
                resetReason,
                ina.valid && Number.isFinite(ina.busVolts)
                  ? Math.round(ina.busVolts * 1000)
                  : ch.vbatMv,
                ina.currentAmps * 1000,
                Number.isFinite(Number(ch.ibatMa)) ? Math.round(Number(ch.ibatMa)) : null,
                therm.temperatureC,
                auto.capacityMah,
              );
            }

            if (auto.state === 'COMPLETE' && !active.finalized) {
              const passed = Number(auto.capacityMah ?? 0) >= config.passThresholdMah ? 1 : 0;
              finalizeRun(active.runId, 'complete', {
                completedAtMs: now,
                capacityMah: Number(auto.capacityMah ?? 0),
                restingVoltageMv: Number(auto.restingVoltageMv ?? 0),
                activeVoltageMv: Number(auto.activeVoltageMv ?? 0),
                passed,
              });
              active.finalized = true;
              saveActiveRuns();
            } else if (auto.state === 'FAULT' && !active.finalized) {
              finalizeRun(active.runId, 'fault', {
                completedAtMs: now,
                capacityMah: Number(auto.capacityMah ?? 0),
                restingVoltageMv: Number(auto.restingVoltageMv ?? 0),
                activeVoltageMv: Number(auto.activeVoltageMv ?? 0),
                faultReason: String(auto.faultReason ?? '') || null,
              });
              active.finalized = true;
              saveActiveRuns();
            }

            active.lastState = auto.state;
          }
        }
      }
      pruneStateStartTimesForBoard(ip, activeStateKeys);

      const prevBootId = String(prevState?.system?.bootId ?? '');
      const nextBootId = String(data?.system?.bootId ?? '');
      if (
        prevBootId &&
        nextBootId &&
        prevBootId !== nextBootId &&
        isUnexpectedResetReason(resetReason)
      ) {
        recordCrashEvent(
          ip,
          nextBootId,
          resetReason,
          'crash',
          false,
          false,
          { source: 'polling', previousBootId: prevBootId },
          prevState ? JSON.stringify(prevState) : null,
        );
      }

      const stateForStorage = { ...data, online: true, lastSeen: now };
      upsertLastStatus.run(ip, now, JSON.stringify(stateForStorage));
      boardStates.set(ip, { ...stateForStorage, crash: getCrashSummary(ip) });
  } catch {
    markBoardPollFailure(ip);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function pollBoards() {
  if (boardPollInFlight) {
    return;
  }
  boardPollInFlight = true;
  try {
    await Promise.all(config.boards.map((ip) => pollBoard(ip)));
    refreshActiveRangeAlerts();
    broadcastState();
    await maybeNotifyHomeAssistantSwapReady();
    await maybeNotifyHomeAssistantRangeAlerts();
  } finally {
    boardPollInFlight = false;
  }
}

setInterval(() => {
  void pollBoards();
}, 1000);

server.listen(PORT, () => {
  console.log(`Hub running on port ${PORT}`);
  if (SWAP_WEBHOOK_URL) {
    console.log('Swap alerts enabled: webhook when every occupied bay is finished');
  } else {
    console.log('Swap alerts disabled: set HOME_ASSISTANT_SWAP_WEBHOOK_URL to enable');
  }
  if (THERMAL_WEBHOOK_URL) {
    console.log(
      `Range alerts enabled: cell temp ${CELL_TEMP_MIN_C}-${CELL_TEMP_MAX_C}C, heatsink ${HEATSINK_TEMP_MIN_C}-${HEATSINK_TEMP_MAX_C}C, chemistry voltage window`,
    );
  } else {
    console.log(
      'Range alerts disabled: set HOME_ASSISTANT_THERMAL_WEBHOOK_URL or HOME_ASSISTANT_SWAP_WEBHOOK_URL',
    );
  }
});
