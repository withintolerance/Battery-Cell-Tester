/** Shared AudioContext so we can unlock once and reuse for later saves. */
let sharedCtx: AudioContext | null = null;
let unlockBound = false;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;

  const AudioCtx =
    window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;

  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new AudioCtx();
  }
  return sharedCtx;
}

/** Call from a click/keydown so the browser allows later chimes. */
export function unlockAudio(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => undefined);
  }
}

/** Bind once: any pointer/key interaction unlocks audio for auto-saves. */
export function ensureAudioUnlockListeners(): void {
  if (typeof window === "undefined" || unlockBound) return;
  unlockBound = true;
  const unlock = () => {
    unlockAudio();
  };
  window.addEventListener("pointerdown", unlock, { capture: true });
  window.addEventListener("keydown", unlock, { capture: true });
}

async function playTones(
  tones: Array<{ freq: number; start: number; duration: number; gainPeak: number }>,
): Promise<void> {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    // Still suspended → browser blocked audio (no user gesture yet).
    if (ctx.state !== "running") return;

    const now = ctx.currentTime;
    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = tone.freq;
      const start = now + tone.start;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(tone.gainPeak, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + tone.duration + 0.02);
    }
  } catch {
    // Audio can fail (autoplay policy / missing hardware); ignore.
  }
}

/** Short two-tone chime for successful IR save confirmation. */
export async function playSuccessSound(): Promise<void> {
  await playTones([
    { freq: 880, start: 0, duration: 0.14, gainPeak: 0.45 },
    { freq: 1320, start: 0.14, duration: 0.22, gainPeak: 0.4 },
  ]);
}

/** Descending alarm for out-of-range telemetry. */
export async function playAlertSound(): Promise<void> {
  await playTones([
    { freq: 660, start: 0, duration: 0.18, gainPeak: 0.5 },
    { freq: 440, start: 0.16, duration: 0.22, gainPeak: 0.45 },
    { freq: 330, start: 0.34, duration: 0.28, gainPeak: 0.4 },
  ]);
}
