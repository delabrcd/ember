'use client';

// The shared amber-pill segmented toggle (issue #150). Four near-identical copies
// lived in IntervalHistory, IntervalLoadShape, IntervalHeatmap and
// ConfigurableChart; this is the single generic implementation they all use now.
//
// It accepts EITHER option shape so every prior call site is preserved verbatim:
//   • a plain value array  — `options={['bar','line','area']}` (ConfigurableChart),
//     usually paired with `capitalize` so the raw enum value renders Title-cased; or
//   • a {label,value} array — `options={[{label:'Electric',value:'ELECTRIC'}]}`
//     (the interval widgets), where the label and value differ.
// `disabledValues` greys out and no-ops the listed values (the load-shape widget
// disables 15-min granularity for gas). The visual classes are byte-identical to
// the originals (amber-500 selected / slate idle / disabled muted).

type Option<T extends string> = { label: string; value: T };

// Normalize either accepted option shape into the internal {label,value} form.
function normalize<T extends string>(opts: readonly (T | Option<T>)[]): Option<T>[] {
  return opts.map((o) => (typeof o === 'string' ? { label: o, value: o } : o));
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabledValues,
  capitalize = false,
}: {
  value: T;
  options: readonly (T | Option<T>)[];
  onChange: (v: T) => void;
  disabledValues?: Set<T>;
  // ConfigurableChart rendered raw enum values (`bar`/`linear`) via a `capitalize`
  // class; opt in to keep that exact rendering.
  capitalize?: boolean;
}) {
  const items = normalize(options);
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-slate-700">
      {items.map((o) => {
        const disabled = disabledValues?.has(o.value) ?? false;
        return (
          <button
            key={o.value}
            onClick={() => !disabled && onChange(o.value)}
            disabled={disabled}
            className={`px-2.5 py-1 text-xs ${capitalize ? 'capitalize ' : ''}transition ${
              value === o.value
                ? 'bg-amber-500 text-slate-950'
                : disabled
                  ? 'cursor-not-allowed bg-slate-800/50 text-slate-600'
                  : 'bg-slate-800/50 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
