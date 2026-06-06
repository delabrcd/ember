import { SettingsView } from '@/components/SettingsView';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <SettingsView />
    </div>
  );
}
