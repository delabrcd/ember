'use client';

// The Customize-mode widget palette (Phase E, issue #73; RFC §3.3: "a widget
// palette to add back removed/available widgets"). Shown only while customizing,
// it lists every AVAILABLE-but-not-placed widget (charts the user hid, stat
// cards they removed, the bills panel if removed) grouped by category, each with
// an "Add" button that drops it back into the lg grid at its default slot.
//
// Adding is a placement+visibility change owned by the host (Dashboard) — the
// palette is purely presentational: it's handed the removed widgets and an
// onAdd callback. Themed for the dark slate/amber look like the rest of the UI.

import { getWidget } from '@/lib/widgets/registry';

export interface PaletteGroup {
  label: string;
  // Widget types currently REMOVED (available to add back), in a stable order.
  types: string[];
}

export function WidgetPalette({ groups, onAdd }: { groups: PaletteGroup[]; onAdd: (type: string) => void }) {
  const empty = groups.every((g) => g.types.length === 0);
  return (
    <div className="shrink-0 rounded-xl border border-amber-500/30 bg-slate-900/70 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-amber-300/90">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Add a widget
      </div>
      {empty ? (
        <p className="text-xs text-slate-500">Everything&apos;s on your dashboard. Remove a widget (×) to add it back here.</p>
      ) : (
        <div className="space-y-2">
          {groups.map((g) =>
            g.types.length === 0 ? null : (
              <div key={g.label}>
                <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">{g.label}</div>
                <div className="flex flex-wrap gap-1.5">
                  {g.types.map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => onAdd(type)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-700/70 bg-slate-800/50 px-2.5 py-1 text-xs text-slate-200 transition hover:border-amber-500/50 hover:bg-slate-700 hover:text-white"
                    >
                      <svg className="h-3 w-3 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                      {getWidget(type).title}
                    </button>
                  ))}
                </div>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
