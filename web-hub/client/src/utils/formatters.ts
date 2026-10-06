/**
 * Shared formatting utilities for duration and test metrics
 */

export function formatDurationHms(val: number | string | undefined | null): string {
  if (val === undefined || val === null || val === '' || val === '-') return '-';

  if (typeof val === 'number') {
    const totalSecs = Math.max(0, Math.floor(val));
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  const str = String(val).trim();
  if (!str || str === '-') return '-';

  // Already formatted like "1h 12m 4s" or "1m 24s" or "45s"
  if (/^\d+h\s*\d+m\s*\d+s$/i.test(str) || /^\d+m\s*\d+s$/i.test(str)) {
    return str;
  }

  // Format like "00:10:35" or "01:23:45"
  if (str.includes(':')) {
    const parts = str.split(':').map((p) => parseInt(p, 10));
    if (parts.length === 3 && !parts.some(isNaN)) {
      const [h, m, s] = parts;
      if (h > 0) return `${h}h ${m}m ${s}s`;
      if (m > 0) return `${m}m ${s}s`;
      return `${s}s`;
    } else if (parts.length === 2 && !parts.some(isNaN)) {
      const [m, s] = parts;
      if (m > 0) return `${m}m ${s}s`;
      return `${s}s`;
    }
  }

  // Number string like "635s" or "635" or "657s"
  const numMatch = str.match(/^(\d+)/);
  if (numMatch) {
    const totalSecs = parseInt(numMatch[1], 10);
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  return str;
}

// Alias for backwards compatibility
export const formatDuration = formatDurationHms;
