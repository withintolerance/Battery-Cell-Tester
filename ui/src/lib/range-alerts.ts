import type { RangeAlert } from "@/lib/types";

export interface RangeAlertHighlights {
  /** `${boardIp}:${channel}` keys with out-of-range cell voltage. */
  voltageKeys: ReadonlySet<string>;
  /** `${boardIp}:${channel}` keys with out-of-range or invalid cell temp. */
  cellTempKeys: ReadonlySet<string>;
  /** Board IPs with out-of-range heatsink temp. */
  heatsinkKeys: ReadonlySet<string>;
}

const EMPTY_HIGHLIGHTS: RangeAlertHighlights = {
  voltageKeys: new Set(),
  cellTempKeys: new Set(),
  heatsinkKeys: new Set(),
};

export function cellAlertKey(boardIp: string, channel: number): string {
  return `${boardIp}:${channel}`;
}

/** Map hub alerts into per-metric highlight keys for the board cards. */
export function computeRangeAlertHighlights(
  alerts: RangeAlert[] | undefined,
): RangeAlertHighlights {
  if (!alerts?.length) {
    return EMPTY_HIGHLIGHTS;
  }

  const voltageKeys = new Set<string>();
  const cellTempKeys = new Set<string>();
  const heatsinkKeys = new Set<string>();

  for (const alert of alerts) {
    if (alert.metric === "heatsink_temp") {
      heatsinkKeys.add(alert.boardIp);
      continue;
    }

    if (alert.channel == null) {
      continue;
    }

    const key = cellAlertKey(alert.boardIp, alert.channel);
    if (alert.metric === "cell_voltage") {
      voltageKeys.add(key);
    } else if (alert.metric === "cell_temp" || alert.metric === "cell_temp_invalid") {
      cellTempKeys.add(key);
    }
  }

  return { voltageKeys, cellTempKeys, heatsinkKeys };
}

export function formatRangeAlertTitle(alert: RangeAlert): string {
  if (alert.metric === "cell_temp_invalid") {
    return "Cell temperature sensor invalid";
  }
  if (alert.value == null) {
    return alert.message;
  }
  const unit = alert.unit;
  const formatted =
    unit === "V" ? alert.value.toFixed(3) : alert.value.toFixed(1);
  return `${formatted} ${unit} is out of range`;
}
