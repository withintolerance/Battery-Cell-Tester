/**
 * Board / bay ordering for the dashboard.
 * Display order follows the hub Settings board list (left → right).
 * Keep CHANNEL_START_ORDER in sync with hub/src/board-layout.ts.
 *
 * Within each board the UI shows Channel B (left) then Channel A (right).
 */

export const CHANNEL_START_ORDER: readonly number[] = [2, 1];

export type BayRef = { boardIp: string; channel: number };

/**
 * Order boards for display.
 * When `preferredOrder` is provided (typically the Settings board list), that
 * order wins. Remaining IPs are appended sorted numerically.
 */
export function sortBoardsForDisplay(
  ips: Iterable<string>,
  preferredOrder: readonly string[] = [],
): string[] {
  const available = new Set(ips);
  const ordered: string[] = [];
  const placed = new Set<string>();

  for (const ip of preferredOrder) {
    if (!available.has(ip) || placed.has(ip)) continue;
    ordered.push(ip);
    placed.add(ip);
  }

  if (Array.isArray(ips)) {
    for (const ip of ips) {
      if (!available.has(ip) || placed.has(ip)) continue;
      ordered.push(ip);
      placed.add(ip);
    }
  }

  const extras = Array.from(available)
    .filter((ip) => !placed.has(ip))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return [...ordered, ...extras];
}

export function orderedBays(
  boards: Iterable<string>,
  preferredOrder: readonly string[] = Array.isArray(boards) ? boards : [],
): BayRef[] {
  const bays: BayRef[] = [];
  for (const boardIp of sortBoardsForDisplay(boards, preferredOrder)) {
    for (const channel of CHANNEL_START_ORDER) {
      bays.push({ boardIp, channel });
    }
  }
  return bays;
}

export function baySlotCount(
  boards: Iterable<string>,
  preferredOrder?: readonly string[],
): number {
  return orderedBays(boards, preferredOrder).length;
}
