'use client';

import { accountOptionLabel, type AccountGroup } from '@/lib/accountSwitcher';

// Header control for picking the billing account the dashboard is scoped to.
// Only rendered when there's more than one account (the single-account install
// keeps the plain label line in the header — no switcher chrome). A native
// <select> keeps it declarative + accessible; multiple logins surface as
// <optgroup>s labelled by their login, a single login renders one flat list.
//
// selectedId null means "the default account" (the first one, which the API
// resolves with no ?accountId=). We map null → that first account's id for the
// control's value so it always shows a concrete selection.
export function AccountSwitcher({
  groups,
  selectedId,
  onSelect,
}: {
  groups: AccountGroup[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const all = groups.flatMap((g) => g.accounts);
  const defaultId = all[0]?.id ?? null;
  const value = selectedId ?? defaultId ?? '';

  return (
    <label className="flex items-center gap-2 text-sm text-slate-400">
      <span className="text-slate-500">Account</span>
      <select
        className="rounded border border-slate-700/70 bg-slate-800/40 px-2 py-1 text-slate-200 focus:border-amber-500 focus:outline-none"
        value={value}
        onChange={(e) => onSelect(Number(e.target.value))}
        aria-label="Select billing account"
      >
        {groups.map((g) =>
          g.label ? (
            <optgroup key={g.loginId ?? 'env'} label={g.label}>
              {g.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountOptionLabel(a)}
                </option>
              ))}
            </optgroup>
          ) : (
            g.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {accountOptionLabel(a)}
              </option>
            ))
          )
        )}
      </select>
    </label>
  );
}
