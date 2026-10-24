/**
 * The maintenance window: "HH:MM-HH:MM" in the node's local time (the
 * container's TZ). A window may cross midnight ("23:00-01:00").
 */
export function parseWindow(spec) {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec((spec || '').trim());
  if (!m) throw new Error(`UPDATE_WINDOW must look like 03:00-05:00, got "${spec}"`);
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) throw new Error(`UPDATE_WINDOW has an impossible time: "${spec}"`);
  return { start: h1 * 60 + m1, end: h2 * 60 + m2 };
}

export function inWindow(date, window) {
  const minute = date.getHours() * 60 + date.getMinutes();
  if (window.start === window.end) return true; // a zero-length window means "always"
  return window.start < window.end
    ? minute >= window.start && minute < window.end
    : minute >= window.start || minute < window.end;
}
