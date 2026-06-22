// Shared chart THEME constants (issue #150). These were copy-pasted across the
// chart components (ConfigurableChart, VizCharts, and the three interval widgets);
// centralizing them keeps the dashboard's dark-slate / amber-elec / sky-gas look
// consistent and prevents drift. This is a pure CONSTANTS module (no React, no
// I/O), so it's fine to import from components — standards §5.
//
// Tokens: #0f172a card · #1e293b border · #475569 axis · #f59e0b amber (electric)
// · #38bdf8 sky (gas).

// The Recharts <Tooltip contentStyle> object shared by every chart.
export const TOOLTIP_STYLE = {
  backgroundColor: '#0f172a',
  border: '1px solid #1e293b',
  borderRadius: 12,
  fontSize: 12,
} as const;

// The spread props applied to every <XAxis>/<YAxis> (slate stroke, small font).
export const AXIS_STYLE = { stroke: '#475569', fontSize: 11 } as const;

// Per-fuel line/fill colors. ELECTRIC = amber, GAS = sky. (VizCharts also uses
// the electric amber as its generic accent — re-export ELECTRIC for that.)
export const FUEL_COLORS = { ELECTRIC: '#f59e0b', GAS: '#38bdf8' } as const;

// Human labels + units for the two fuels (mirrors the interval widgets).
export const FUEL_LABEL = { ELECTRIC: 'Electric', GAS: 'Gas' } as const;
export const FUEL_UNIT = { ELECTRIC: 'kWh', GAS: 'therms' } as const;
// Peak demand is average POWER over the interval: kW for electric, therms/h for gas.
export const POWER_UNIT = { ELECTRIC: 'kW', GAS: 'therms/h' } as const;
