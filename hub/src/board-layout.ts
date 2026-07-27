/**
 * Board / bay ordering for Start All, Reset All, and cell-id assignment.
 * Display order follows the hub Settings board list (left → right).
 * Keep CHANNEL_START_ORDER in sync with ui/src/lib/board-layout.ts.
 */

/** Within a board: Channel B (left) then Channel A (right), matching the UI. */
export const CHANNEL_START_ORDER: readonly number[] = [2, 1];

export type BayRef = { boardIp: string; channel: number };

/**
 * Order boards for display and automation.
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

  // Preserve first-seen order when the input is already an array (e.g. config.boards).
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

/** Left → right bay order used for Start All and cell-number assignment. */
export function orderedBays(boards: Iterable<string>): BayRef[] {
  const preferred = Array.isArray(boards) ? boards : [];
  const bays: BayRef[] = [];
  for (const boardIp of sortBoardsForDisplay(boards, preferred)) {
    for (const channel of CHANNEL_START_ORDER) {
      bays.push({ boardIp, channel });
    }
  }
  return bays;
}

export function baySlotCount(boards: Iterable<string>): number {
  return orderedBays(boards).length;
}

export function bayIndex(boardIp: string, channel: number, boards: Iterable<string>): number {
  return orderedBays(boards).findIndex((bay) => bay.boardIp === boardIp && bay.channel === channel);
}

/** Which physical bay cell N belongs on (1-based cell ids, repeating every fleet width). */
export function expectedBayForCellId(cellId: number, boards: Iterable<string>): BayRef | null {
  if (!Number.isFinite(cellId) || cellId <= 0) return null;
  const bays = orderedBays(boards);
  if (bays.length === 0) return null;
  return bays[(cellId - 1) % bays.length] ?? null;
}

export function shortBoardIp(ip: string): string {
  const parts = ip.split('.');
  return parts[parts.length - 1] || ip;
}
