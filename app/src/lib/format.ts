// Client-safe formatting helpers.
export const usd = (n: number | null | undefined, dp = 2): string =>
  n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

export const num = (n: number | null | undefined, dp = 0): string =>
  n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

export const rate = (n: number | null | undefined, dp = 3): string => (n == null ? '—' : `$${n.toFixed(dp)}`);

export function relativeFromNow(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const past = diff >= 0;
  const s = Math.abs(diff) / 1000;
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.345, 'week'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];
  let v = s;
  let name = 'second';
  for (const [div, label] of units) {
    if (v < div) { name = label; break; }
    v /= div;
    name = label;
  }
  const rounded = Math.round(v);
  const plural = rounded === 1 ? '' : 's';
  return past ? `${rounded} ${name}${plural} ago` : `in ${rounded} ${name}${plural}`;
}

export const dateLabel = (iso: string | null | undefined): string =>
  !iso ? '—' : new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

// The verbose next-bill-estimate detail moved behind an ⓘ tooltip (issue #38) so
// the card itself stays compact and the word "estimate(d)" is stated ONCE. The
// basis (already a human-readable projection note) is folded into a single
// disclaimer sentence. PURE — unit-tested. Exported for the cockpit and tests.
export const estimateTooltip = (basis: string | null | undefined): string => {
  const b = (basis ?? '').trim();
  return b ? `Estimated from ${b}. Not a real charge.` : 'Estimated. Not a real charge.';
};
