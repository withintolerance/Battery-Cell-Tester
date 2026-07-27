import type {
  BulkAutomationResponse,
  CellIrMeasurement,
  CellResult,
  ChemistryId,
  ChemistryInfo,
  CommandResponse,
  CrashResponse,
  HubConfig,
  IrListResponse,
  IrNextCellResponse,
  MeterResponse,
  RunDetailResponse,
  RunListResponse,
  StartAutomationResponse,
} from "./types";

const HUB_BASE = process.env.NEXT_PUBLIC_HUB_URL ?? "http://localhost:3001";
const HUB_WS = process.env.NEXT_PUBLIC_HUB_WS ?? "ws://localhost:3001";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${HUB_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(
      typeof data === "object" && data && "error" in data && data.error
        ? String(data.error)
        : `Request failed (${response.status})`,
    );
  }
  return data;
}

export function getApiBaseUrl(): string {
  return HUB_BASE;
}

export function getWsUrl(): string {
  return HUB_WS;
}

export async function fetchConfig(): Promise<HubConfig> {
  return request<HubConfig>("/api/config");
}

export async function updateConfig(config: Partial<HubConfig>): Promise<HubConfig> {
  return request<HubConfig>("/api/config", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export async function testHomeAssistantIntegration(): Promise<{ ok: boolean; message: string }> {
  return request<{ ok: boolean; message: string }>("/api/integrations/home-assistant/test", {
    method: "POST",
  });
}

export async function fetchResults(): Promise<CellResult[]> {
  return request<CellResult[]>("/api/results");
}

export async function fetchRuns(params?: {
  limit?: number;
  offset?: number;
  cellId?: number;
}): Promise<RunListResponse> {
  const search = new URLSearchParams();
  if (params?.limit != null) search.set("limit", String(params.limit));
  if (params?.offset != null) search.set("offset", String(params.offset));
  if (params?.cellId != null && params.cellId > 0) search.set("cellId", String(params.cellId));
  const query = search.toString();
  return request<RunListResponse>(`/api/runs${query ? `?${query}` : ""}`);
}

export async function fetchRun(runId: number): Promise<RunDetailResponse> {
  return request<RunDetailResponse>(`/api/runs/${encodeURIComponent(runId)}`);
}

export async function fetchCrashes(boardIp?: string): Promise<CrashResponse> {
  const query = boardIp ? `?boardIp=${encodeURIComponent(boardIp)}` : "";
  return request<CrashResponse>(`/api/crashes${query}`);
}

export async function clearBoardCrashes(ip: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/crashes/${ip}/clear`, {
    method: "POST",
  });
}

export interface ClearHistoricalDataResponse {
  ok: boolean;
  deleted: {
    logs: number;
    results: number;
    runs: number;
    ir?: number;
    crashes: number;
    recoveryStates: number;
    statusSnapshots: number;
  };
  nextCellId: number;
}

export async function clearHistoricalData(
  confirmation: string,
  resetNextCellId: boolean,
): Promise<ClearHistoricalDataResponse> {
  return request<ClearHistoricalDataResponse>("/api/data/clear", {
    method: "POST",
    body: JSON.stringify({ confirmation, resetNextCellId }),
  });
}

export async function startAutomation(params: {
  boardIp: string;
  channel: 1 | 2;
  mode: "new" | "retest";
  cellId?: number;
}): Promise<StartAutomationResponse> {
  return request<StartAutomationResponse>("/api/automation/start", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function stopAutomation(params: {
  boardIp: string;
  channel: 1 | 2;
}): Promise<CommandResponse> {
  return request<CommandResponse>("/api/automation/stop", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function startAllAutomation(options?: {
  force?: boolean;
}): Promise<BulkAutomationResponse> {
  return request<BulkAutomationResponse>("/api/automation/start-all", {
    method: "POST",
    body: JSON.stringify({ force: options?.force === true }),
  });
}

export async function resetAllFinished(): Promise<BulkAutomationResponse> {
  return request<BulkAutomationResponse>("/api/automation/reset-all", {
    method: "POST",
  });
}

// Proxy commands to specific boards
export async function setCharge(
  ip: string,
  channel: 1 | 2,
  enabled: boolean,
): Promise<CommandResponse> {
  return request<CommandResponse>(`/api/proxy/${ip}/api/channel/${channel}/charge`, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export async function setDischarge(
  ip: string,
  channel: 1 | 2,
  duty: number,
): Promise<CommandResponse> {
  return request<CommandResponse>(`/api/proxy/${ip}/api/channel/${channel}/discharge`, {
    method: "POST",
    body: JSON.stringify({ duty }),
  });
}

export async function setIchg(
  ip: string,
  channel: 1 | 2,
  milliamps: number,
): Promise<CommandResponse> {
  return request<CommandResponse>(`/api/proxy/${ip}/api/channel/${channel}/ichg`, {
    method: "POST",
    body: JSON.stringify({ milliamps }),
  });
}

export async function allOff(ip: string): Promise<CommandResponse> {
  return request<CommandResponse>(`/api/proxy/${ip}/api/alloff`, {
    method: "POST",
  });
}

export async function setChemistry(
  ip: string,
  chemistry: ChemistryId,
): Promise<{ ok: boolean; chemistry: ChemistryInfo }> {
  return request<{ ok: boolean; chemistry: ChemistryInfo }>(`/api/proxy/${ip}/api/chemistry`, {
    method: "POST",
    body: JSON.stringify({ chemistry }),
  });
}

export async function fetchMeter(): Promise<MeterResponse> {
  return request<MeterResponse>("/api/meter");
}

export async function fetchIrMeasurements(): Promise<IrListResponse> {
  return request<IrListResponse>("/api/ir");
}

export async function fetchNextIrCell(from?: number): Promise<IrNextCellResponse> {
  const search = new URLSearchParams();
  if (from != null && from > 0) search.set("from", String(from));
  const query = search.toString();
  return request<IrNextCellResponse>(`/api/ir/next-cell${query ? `?${query}` : ""}`);
}

export async function saveCellIr(params: {
  cellId: number;
  irMohm: number;
  voltageV: number;
  source?: "meter" | "manual";
  skipValidation?: boolean;
}): Promise<{ ok: boolean; measurement: CellIrMeasurement }> {
  return request<{ ok: boolean; measurement: CellIrMeasurement }>(
    `/api/ir/${encodeURIComponent(params.cellId)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        irMohm: params.irMohm,
        voltageV: params.voltageV,
        source: params.source ?? "meter",
        skipValidation: params.skipValidation ?? false,
      }),
    },
  );
}
