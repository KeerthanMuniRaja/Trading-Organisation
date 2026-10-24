// Replay clock (REPLAY-01): makes a Node process (the backend, the cycle and its scripts) live at a virtual time, so a
// past stretch of trading days can be replayed through the real code in an afternoon. Preloaded, it changes no code:
//   REPLAY_CLOCK_FILE=<file> DATABASE_PATH=<a replay database> node --import ./scripts/replay-clock.mjs backend/dist/src/main.js
// The file holds {"now": "<ISO time>"}; virtual time = that time + the real time since the file was last written, so
// writing a new time jumps the clock (to the next trading day, say) and it then runs on normally. The embedded database
// (PGlite) reads the same JavaScript clock, so SQL now() follows too (checked 27 Oct 2026). Safety: it refuses to run
// unless DATABASE_PATH names a replay database (its path contains "replay"), so the live organisation can never be
// written at a false time. Without REPLAY_CLOCK_FILE it does nothing.
import { readFileSync, statSync } from 'node:fs';

const file = process.env.REPLAY_CLOCK_FILE;
if (file) {
  if (!/replay/i.test(process.env.DATABASE_PATH ?? '')) {
    throw new Error('Replay clock refused: DATABASE_PATH must name a replay database (a path containing "replay"), never the live one');
  }
  const RealDate = Date, realNow = RealDate.now.bind(RealDate);
  let base = NaN, writtenAt = 0, seen = -1;
  const load = () => {
    try {
      const mtime = statSync(file).mtimeMs;
      if (mtime === seen) return;
      const t = RealDate.parse(JSON.parse(readFileSync(file, 'utf8')).now);
      if (!Number.isNaN(t)) { base = t; writtenAt = mtime; seen = mtime; }
    } catch { /* keep the last good time */ }
  };
  load();
  if (Number.isNaN(base)) throw new Error(`Replay clock refused: ${file} must hold {"now": "<ISO time>"}`);
  setInterval(load, 200).unref();
  const now = () => base + (realNow() - writtenAt);
  // a function, not a class, so Date() called without new still returns a string, as the real one does
  function ReplayDate(...args) {
    if (!new.target) return new RealDate(now()).toString();
    return args.length ? new RealDate(...args) : new RealDate(now());
  }
  Object.setPrototypeOf(ReplayDate, RealDate);
  ReplayDate.prototype = RealDate.prototype;
  ReplayDate.now = now;
  ReplayDate.parse = RealDate.parse;
  ReplayDate.UTC = RealDate.UTC;
  globalThis.Date = ReplayDate;
}
