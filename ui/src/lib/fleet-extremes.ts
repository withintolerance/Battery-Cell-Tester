import type { StatusResponse } from "@/lib/types";

/** Visual left/right cell order matching the physical bay layout. */
export const CELL_SLOTS = [
  { channelIndex: 1, thermistorIndex: 0 },
  { channelIndex: 0, thermistorIndex: 2 },
] as const;

export interface FleetExtremes {
  /** `${boardIp}:${channelNumber}` keys for the lowest INA Kelvin voltage(s). */
  lowestVoltageKeys: ReadonlySet<string>;
  /** Board IPs with the highest heatsink temperature. */
  highestHeatsinkKeys: ReadonlySet<string>;
  /** `${boardIp}:${channelNumber}` keys for the hottest cell temp(s). */
  highestCellTempKeys: ReadonlySet<string>;
}

export function cellExtremeKey(ip: string, channel: number): string {
  return `${ip}:${channel}`;
}

const EMPTY_EXTREMES: FleetExtremes = {
  lowestVoltageKeys: new Set(),
  highestHeatsinkKeys: new Set(),
  highestCellTempKeys: new Set(),
};

function collectExtremeKeys(
  samples: Array<{ key: string; value: number }>,
  mode: "min" | "max",
): Set<string> {
  if (samples.length < 2) {
    return new Set();
  }

  let extreme = mode === "min" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    if (mode === "min") {
      extreme = Math.min(extreme, sample.value);
    } else {
      extreme = Math.max(extreme, sample.value);
    }
  }

  return new Set(
    samples
      .filter((sample) => sample.value === extreme)
      .map((sample) => sample.key),
  );
}

/**
 * Compute fleet-wide extremes across every online board and present cell.
 * Highlights are omitted when fewer than two comparable samples exist.
 */
export function computeFleetExtremes(
  boardStates: Record<string, StatusResponse | undefined>,
): FleetExtremes {
  const voltageSamples: Array<{ key: string; value: number }> = [];
  const heatsinkSamples: Array<{ key: string; value: number }> = [];
  const cellTempSamples: Array<{ key: string; value: number }> = [];

  for (const [ip, status] of Object.entries(boardStates)) {
    if (!status?.online) continue;

    const heatsink = status.thermistors?.[1];
    if (heatsink?.valid && Number.isFinite(heatsink.temperatureC)) {
      heatsinkSamples.push({ key: ip, value: heatsink.temperatureC });
    }

    if (!status.channels) continue;

    for (const { channelIndex, thermistorIndex } of CELL_SLOTS) {
      const channel = status.channels[channelIndex];
      if (!channel?.cellPresent) continue;

      const ina = status.ina?.[channelIndex];
      if (ina?.valid && Number.isFinite(ina.busVolts)) {
        voltageSamples.push({
          key: cellExtremeKey(ip, channel.channel),
          value: ina.busVolts,
        });
      }

      const thermistor = status.thermistors?.[thermistorIndex];
      if (thermistor?.valid && Number.isFinite(thermistor.temperatureC)) {
        cellTempSamples.push({
          key: cellExtremeKey(ip, channel.channel),
          value: thermistor.temperatureC,
        });
      }
    }
  }

  if (
    voltageSamples.length === 0 &&
    heatsinkSamples.length === 0 &&
    cellTempSamples.length === 0
  ) {
    return EMPTY_EXTREMES;
  }

  return {
    lowestVoltageKeys: collectExtremeKeys(voltageSamples, "min"),
    highestHeatsinkKeys: collectExtremeKeys(heatsinkSamples, "max"),
    highestCellTempKeys: collectExtremeKeys(cellTempSamples, "max"),
  };
}
