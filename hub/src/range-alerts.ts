/** Absolute telemetry limits for browser + Home Assistant out-of-range alerts. */

export const CELL_TEMP_MIN_C = 15;
export const CELL_TEMP_MAX_C = 38;
export const HEATSINK_TEMP_MIN_C = 15;
export const HEATSINK_TEMP_MAX_C = 50;
/** Rearm only after the reading recovers past the threshold by this amount. */
export const TEMP_ALERT_HYSTERESIS_C = 3;
/**
 * Voltage must leave the chemistry window by this much before alerting, so
 * normal discharge/charge endpoints do not spam.
 */
export const VOLTAGE_ALERT_SLACK_MV = 150;

export type RangeAlertMetric =
  | 'cell_temp'
  | 'heatsink_temp'
  | 'cell_voltage'
  | 'cell_temp_invalid';

export type RangeAlertDirection = 'high' | 'low' | 'invalid';

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

interface BoardLike {
  online?: boolean;
  chemistry?: {
    maxChargeVoltageMv?: number;
    dischargeCutoffMv?: number;
  };
  channels?: Array<{
    channel?: number;
    cellPresent?: boolean;
  } | null>;
  ina?: Array<{
    valid?: boolean;
    busVolts?: number;
  } | null>;
  thermistors?: Array<{
    valid?: boolean;
    temperatureC?: number;
  } | null>;
  automation?: Array<{
    cellId?: number;
  } | null>;
}

/** Physical bay order: CH2 (Cell B) uses thermistor 0; CH1 (Cell A) uses thermistor 2. */
const CELL_SLOTS = [
  { channelIndex: 1, thermistorIndex: 0 },
  { channelIndex: 0, thermistorIndex: 2 },
] as const;

function cellLabel(cellId: number | null, boardIp: string, channel: number): string {
  const cell =
    cellId && cellId > 0 ? `Cell-${String(cellId).padStart(3, '0')} ` : '';
  return `${cell}on ${boardIp}/CH${channel}`;
}

/**
 * Evaluate every online board and return the alerts that are actively out of
 * range right now (no edge-trigger / hysteresis — callers manage that).
 */
export function collectActiveRangeAlerts(
  boardStates: Map<string, BoardLike> | Iterable<[string, BoardLike]>,
): RangeAlert[] {
  const alerts: RangeAlert[] = [];

  for (const [boardIp, status] of boardStates) {
    if (!status?.online || !Array.isArray(status.thermistors)) {
      continue;
    }

    const heatsink = status.thermistors[1];
    if (heatsink?.valid && Number.isFinite(Number(heatsink.temperatureC))) {
      const temperatureC = Number(heatsink.temperatureC);
      if (temperatureC >= HEATSINK_TEMP_MAX_C) {
        alerts.push({
          key: `heatsink_temp_high:${boardIp}`,
          metric: 'heatsink_temp',
          direction: 'high',
          boardIp,
          channel: null,
          cellId: null,
          value: temperatureC,
          min: HEATSINK_TEMP_MIN_C,
          max: HEATSINK_TEMP_MAX_C,
          unit: '°C',
          message: `heatsink on ${boardIp} is ${temperatureC.toFixed(1)}°C (max ${HEATSINK_TEMP_MAX_C}°C)`,
        });
      } else if (temperatureC <= HEATSINK_TEMP_MIN_C) {
        alerts.push({
          key: `heatsink_temp_low:${boardIp}`,
          metric: 'heatsink_temp',
          direction: 'low',
          boardIp,
          channel: null,
          cellId: null,
          value: temperatureC,
          min: HEATSINK_TEMP_MIN_C,
          max: HEATSINK_TEMP_MAX_C,
          unit: '°C',
          message: `heatsink on ${boardIp} is ${temperatureC.toFixed(1)}°C (min ${HEATSINK_TEMP_MIN_C}°C)`,
        });
      }
    }

    for (const { channelIndex, thermistorIndex } of CELL_SLOTS) {
      const channelStatus = status.channels?.[channelIndex];
      if (!channelStatus?.cellPresent) {
        continue;
      }

      const channel = Number(channelStatus.channel ?? channelIndex + 1);
      const cellIdRaw = Number(status.automation?.[channelIndex]?.cellId ?? 0);
      const cellId = cellIdRaw > 0 ? cellIdRaw : null;
      const where = cellLabel(cellId, boardIp, channel);
      const thermistor = status.thermistors[thermistorIndex];

      if (!thermistor?.valid || !Number.isFinite(Number(thermistor.temperatureC))) {
        alerts.push({
          key: `cell_temp_invalid:${boardIp}:${channel}`,
          metric: 'cell_temp_invalid',
          direction: 'invalid',
          boardIp,
          channel,
          cellId,
          value: null,
          min: CELL_TEMP_MIN_C,
          max: CELL_TEMP_MAX_C,
          unit: '°C',
          message: `cell temperature sensor invalid for ${where}`,
        });
      } else {
        const temperatureC = Number(thermistor.temperatureC);
        if (temperatureC >= CELL_TEMP_MAX_C) {
          alerts.push({
            key: `cell_temp_high:${boardIp}:${channel}`,
            metric: 'cell_temp',
            direction: 'high',
            boardIp,
            channel,
            cellId,
            value: temperatureC,
            min: CELL_TEMP_MIN_C,
            max: CELL_TEMP_MAX_C,
            unit: '°C',
            message: `cell temp for ${where} is ${temperatureC.toFixed(1)}°C (max ${CELL_TEMP_MAX_C}°C)`,
          });
        } else if (temperatureC <= CELL_TEMP_MIN_C) {
          alerts.push({
            key: `cell_temp_low:${boardIp}:${channel}`,
            metric: 'cell_temp',
            direction: 'low',
            boardIp,
            channel,
            cellId,
            value: temperatureC,
            min: CELL_TEMP_MIN_C,
            max: CELL_TEMP_MAX_C,
            unit: '°C',
            message: `cell temp for ${where} is ${temperatureC.toFixed(1)}°C (min ${CELL_TEMP_MIN_C}°C)`,
          });
        }
      }

      const ina = status.ina?.[channelIndex];
      const maxChargeMv = Number(status.chemistry?.maxChargeVoltageMv);
      const cutoffMv = Number(status.chemistry?.dischargeCutoffMv);
      if (
        ina?.valid &&
        Number.isFinite(Number(ina.busVolts)) &&
        Number.isFinite(maxChargeMv) &&
        Number.isFinite(cutoffMv) &&
        maxChargeMv > cutoffMv
      ) {
        const voltageMv = Number(ina.busVolts) * 1000;
        const minMv = cutoffMv - VOLTAGE_ALERT_SLACK_MV;
        const maxMv = maxChargeMv + VOLTAGE_ALERT_SLACK_MV;
        if (voltageMv > maxMv) {
          alerts.push({
            key: `cell_voltage_high:${boardIp}:${channel}`,
            metric: 'cell_voltage',
            direction: 'high',
            boardIp,
            channel,
            cellId,
            value: voltageMv / 1000,
            min: minMv / 1000,
            max: maxMv / 1000,
            unit: 'V',
            message: `cell voltage for ${where} is ${(voltageMv / 1000).toFixed(3)} V (max ${(maxMv / 1000).toFixed(3)} V)`,
          });
        } else if (voltageMv < minMv) {
          alerts.push({
            key: `cell_voltage_low:${boardIp}:${channel}`,
            metric: 'cell_voltage',
            direction: 'low',
            boardIp,
            channel,
            cellId,
            value: voltageMv / 1000,
            min: minMv / 1000,
            max: maxMv / 1000,
            unit: 'V',
            message: `cell voltage for ${where} is ${(voltageMv / 1000).toFixed(3)} V (min ${(minMv / 1000).toFixed(3)} V)`,
          });
        }
      }
    }
  }

  return alerts;
}

/**
 * Whether an alert key that was previously active should clear, based on the
 * latest board telemetry (hysteresis for temperature thresholds).
 */
export function shouldClearRangeAlert(
  key: string,
  boardStates: Map<string, BoardLike>,
): boolean {
  const [metric, boardIp, channelRaw] = key.split(':');
  if (!metric || !boardIp) {
    return true;
  }
  const status = boardStates.get(boardIp);
  if (!status?.online) {
    return true;
  }

  if (metric === 'heatsink_temp_high' || metric === 'heatsink_temp_low') {
    const heatsink = status.thermistors?.[1];
    if (!heatsink?.valid || !Number.isFinite(Number(heatsink.temperatureC))) {
      return true;
    }
    const temperatureC = Number(heatsink.temperatureC);
    if (metric === 'heatsink_temp_high') {
      return temperatureC < HEATSINK_TEMP_MAX_C - TEMP_ALERT_HYSTERESIS_C;
    }
    return temperatureC > HEATSINK_TEMP_MIN_C + TEMP_ALERT_HYSTERESIS_C;
  }

  const channel = Number(channelRaw);
  if (!Number.isFinite(channel)) {
    return true;
  }

  const slot = CELL_SLOTS.find(
    ({ channelIndex }) => Number(status.channels?.[channelIndex]?.channel ?? channelIndex + 1) === channel,
  );
  if (!slot) {
    return true;
  }

  const channelStatus = status.channels?.[slot.channelIndex];
  if (!channelStatus?.cellPresent) {
    return true;
  }

  const thermistor = status.thermistors?.[slot.thermistorIndex];
  const ina = status.ina?.[slot.channelIndex];

  if (metric === 'cell_temp_invalid') {
    return Boolean(
      thermistor?.valid && Number.isFinite(Number(thermistor.temperatureC)),
    );
  }

  if (metric === 'cell_temp_high') {
    if (!thermistor?.valid || !Number.isFinite(Number(thermistor.temperatureC))) {
      return true;
    }
    return Number(thermistor.temperatureC) < CELL_TEMP_MAX_C - TEMP_ALERT_HYSTERESIS_C;
  }

  if (metric === 'cell_temp_low') {
    if (!thermistor?.valid || !Number.isFinite(Number(thermistor.temperatureC))) {
      return true;
    }
    return Number(thermistor.temperatureC) > CELL_TEMP_MIN_C + TEMP_ALERT_HYSTERESIS_C;
  }

  if (metric === 'cell_voltage_high' || metric === 'cell_voltage_low') {
    const maxChargeMv = Number(status.chemistry?.maxChargeVoltageMv);
    const cutoffMv = Number(status.chemistry?.dischargeCutoffMv);
    if (
      !ina?.valid ||
      !Number.isFinite(Number(ina.busVolts)) ||
      !Number.isFinite(maxChargeMv) ||
      !Number.isFinite(cutoffMv)
    ) {
      return true;
    }
    const voltageMv = Number(ina.busVolts) * 1000;
    const minMv = cutoffMv - VOLTAGE_ALERT_SLACK_MV;
    const maxMv = maxChargeMv + VOLTAGE_ALERT_SLACK_MV;
    return voltageMv >= minMv && voltageMv <= maxMv;
  }

  return true;
}
