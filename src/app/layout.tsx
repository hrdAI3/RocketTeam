import './globals.css';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Sidebar } from '../components/Sidebar';
import { ToastProvider } from '../components/Toast';

// Source Serif 4 was previously loaded via `next/font/google`, but that path
// fetches the font binaries from fonts.gstatic.com at build time — blocked
// in CN, so the build silently produced empty @font-face entries and the
// browser rendered everything as Georgia / Songti SC fallback (the
// "Workboard looks Bodoni-style" bug). Switch to Windows-bundled Cambria as
// the primary humanist serif: zero network, instant first paint, looks
// nearly identical to Source Serif 4 at h1 sizes. Mac users fall to Iowan
// Old Style / Georgia; Linux falls to DejaVu Serif / Georgia. The
// `.display-title` family in globals.css drives this.

export const metadata = {
  title: 'Status · Rocket Team',
  description: 'Team Claude Code activity and anomaly monitor.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="font-sans bg-paper">
        <ToastProvider>
          <div className="flex min-h-screen">
            <Sidebar />
            <main className="flex-1 min-w-0 relative">{children}</main>
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}
