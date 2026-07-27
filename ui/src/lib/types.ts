export interface WifiInfo {
  connected: boolean;
  ssid: string;
  ip: string;
  status: string;
}

export interface SystemInfo {
  fanOn: boolean;
  rs485Transmit: boolean;
  bootId?: number;
  uptimeMs?: number;
  resetReason?: string;
  i2c1Devices: number;
  i2c2Devices: number;
}

export interface ChannelStatus {
  channel: number;
  label: string;
  valid: boolean;
  cellVoltageMv: number;
  cellPresent: boolean;
  chargeEnabled: boolean;
  dischargeDuty: number;
  ichgLimitMa: number;
  chgStatus: string;
  vbusStatus: string;
  fault0: number;
  ibusMa: number;
  ibatMa: number;
  vbusMv: number;
  vbatMv: number;
  vsysMv: number;
  tdieApproxC: number;
}

export interface InaStatus {
  address: string;
  label: string;
  valid: boolean;
  busVolts: number;
  shuntMilliVolts: number;
  currentAmps: number;
  powerWatts: number;
}

export interface ThermistorStatus {
  adsChannel: number;
  label: string;
  valid: boolean;
  volts: number;
  resistanceOhms: number;
  temperatureC: number;
}

export interface LimitsInfo {
  cellPresentMinMv: number;
  ichgMinMa: number;
  ichgMaxMa: number;
  ichgStepMa: number;
}

export type ChemistryId = "lifepo4" | "nmc_18650";

export interface ChemistryInfo {
  id: ChemistryId;
  label: string;
  maxChargeVoltageMv: number;
  dischargeCutoffMv: number;
  chargeCurrentMa: number;
}

export interface HubConfig {
  boards: string[];
  passThresholdMah: number;
  nextCellId: number;
  freeCellIds?: number[];
  restoreWindowSeconds: number;
  bootLoopWindowSeconds: number;
  bootLoopThreshold: number;
}

export interface AutomationStatus {
  state: string;
  stateStartMs: number;
  serverStateStartMs?: number;
  capacityMah: number;
  restingVoltageMv: number;
  activeVoltageMv: number;
  faultReason: string;
  cellId: number;
}

export interface StatusResponse {
  ok: boolean;
  wifi: WifiInfo;
  system: SystemInfo;
  chemistry: ChemistryInfo;
  channels: ChannelStatus[];
  ina: InaStatus[];
  thermistors: ThermistorStatus[];
  automation: AutomationStatus[];
  limits: LimitsInfo;
  crash?: CrashSummary;
  online?: boolean;
  lastSeen?: number;
}

export interface CommandResponse {
  ok: boolean;
  error?: string;
}

export interface CrashSummary {
  boardIp: string;
  totalCrashes: number;
  unresolvedCrashes: number;
  lastCrashAtMs: number | null;
  blocked: boolean;
  consecutiveRecoveryReboots: number;
}

export interface CrashEvent {
  id: number;
  boardIp: string;
  timestampMs: number;
  bootId: string | null;
  resetReason: string | null;
  eventType: string;
  recoveryAttempted: boolean;
  recoveryAllowed: boolean;
  details: Record<string, unknown>;
  lastStatus: Record<string, unknown> | null;
  acknowledgedAtMs: number | null;
}

export interface CrashResponse {
  summaries: CrashSummary[];
  events: CrashEvent[];
}

export type RunStatus = "running" | "complete" | "fault" | "stopped" | "start_failed";

export interface CellRunSummary {
  run_id: number;
  cell_id: number;
  board_ip: string;
  channel: number;
  status: RunStatus;
  started_at: string | null;
  started_at_ms: number | null;
  completed_at: string | null;
  completed_at_ms: number | null;
  duration_ms: number | null;
  capacity_mah: number | null;
  resting_voltage_mv: number | null;
  active_voltage_mv: number | null;
  passed: 0 | 1 | boolean | null;
  fault_reason: string | null;
  initial_charge_duration_ms: number | null;
  discharge_duration_ms: number | null;
  sample_count: number;
}

/**
 * Recent finished result used by the dashboard summary table. Extends the run
 * summary with a `timestamp` alias for backward compatibility.
 */
export interface CellResult extends CellRunSummary {
  timestamp: string | null;
}

export interface CellLog {
  id: number;
  timestamp: string;
  board_ip: string;
  channel: number;
  cell_id: number;
  run_id: number | null;
  state: string;
  reset_reason: string | null;
  voltage_mv: number;
  current_ma: number;
  ibat_ma: number | null;
  temp_c: number;
  capacity_mah: number;
}

export interface RunListResponse {
  runs: CellRunSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface RunDetailResponse {
  run: CellRunSummary;
  logs: CellLog[];
}

export interface StartAutomationResponse {
  ok: boolean;
  runId: number;
  cellId: number;
  error?: string;
}

export interface BulkBayResult {
  ok: boolean;
  boardIp: string;
  channel: number;
  runId?: number;
  cellId?: number;
  error?: string;
}

export interface BulkAutomationResponse {
  ok: boolean;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  delayMs: number;
  results: BulkBayResult[];
}

export type MeterStatus = "ok" | "ol" | "settling" | "invalid";

export interface MeterReading {
  status: MeterStatus;
  irMohm: number | null;
  voltageV: number | null;
  resistanceDisplay: string;
  receivedAtMs: number;
}

export interface IrLimits {
  irMinMohm: number;
  irMaxMohm: number;
  voltageMinV: number;
  voltageMaxV: number;
}

export interface CellIrMeasurement {
  cellId: number;
  irMohm: number;
  voltageV: number;
  measuredAtMs: number;
  source: "meter" | "manual" | string;
}

export interface IrListResponse {
  measurements: CellIrMeasurement[];
  limits: IrLimits;
}

export interface IrNextCellResponse {
  nextCellId: number | null;
  pendingCount: number;
  from: number;
}

export interface MeterResponse {
  reading: MeterReading | null;
  limits: IrLimits;
}

export type RangeAlertMetric =
  | "cell_temp"
  | "heatsink_temp"
  | "cell_voltage"
  | "cell_temp_invalid";

export type RangeAlertDirection = "high" | "low" | "invalid";

export interface RangeAlert {
  key: string;
  metric: RangeAlertMetric;
  direction: RangeAlertDirection;
  boardIp: string;
  channel: number | null;
  cellId: number | null;
  value: number | null;
  min: number | null;
  max: number | null;
  unit: string;
  message: string;
}
