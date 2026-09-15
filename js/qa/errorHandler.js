export function createErrorBus() {
  const log = [];
  function push(level, ar, en, extra) {
    const rec = { t: Date.now(), level, ar, en, extra: extra || null };
    log.push(rec);
    if (log.length > 400) log.shift();
    return rec;
  }
  function wrap(fn, ar, en) {
    try {
      return fn();
    } catch (err) {
      push("error", ar, en, String(err && err.message ? err.message : err));
      return null;
    }
  }
  return {
    log,
    info: (ar, en, extra) => push("info", ar, en, extra),
    warn: (ar, en, extra) => push("warn", ar, en, extra),
    error: (ar, en, extra) => push("error", ar, en, extra),
    wrap,
  };
}
