// What the HUD's "System" panel can honestly measure inside a web page.
export function createBrowserSystem() {
  const interval = 200;
  let busy = 0;
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (document.hidden) { last = now; return; } // timers are throttled in background tabs
    const lag = Math.max(0, now - last - interval);
    busy = busy * 0.7 + Math.min(100, (lag / interval) * 100) * 0.3;
    last = now;
  }, interval);

  return () => {
    const heap = performance.memory;
    return {
      source: 'browser',
      cpu: Math.round(busy),
      cores: navigator.hardwareConcurrency || 1,
      memory: { usedPct: heap ? Math.round((heap.usedJSHeapSize / heap.jsHeapSizeLimit) * 100) : null, totalGb: navigator.deviceMemory ?? null },
      load: null,
      uptime: Math.round(performance.now() / 1000),
      jarvis: { rssMb: heap ? Math.round(heap.usedJSHeapSize / 1024 ** 2) : null, uptime: Math.round(performance.now() / 1000) },
    };
  };
}
