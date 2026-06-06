import type { Metadata } from 'next';
import './globals.css';
import { PrefsProvider } from '@/lib/prefs';

export const metadata: Metadata = {
  title: 'National Grid Dashboard',
  description: 'Self-hosted analytics for your National Grid usage, bills, and rates.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark h-full">
      {/* The body fills the viewport so the cockpit dashboard (issue #2) can pin a
          no-scroll, full-height grid. Each page owns its own container/padding:
          the dashboard goes edge-to-edge and full-height; settings stays centered. */}
      <body className="h-full min-h-dvh">
        <PrefsProvider>{children}</PrefsProvider>
      </body>
    </html>
  );
}
