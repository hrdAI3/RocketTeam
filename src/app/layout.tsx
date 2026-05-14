import './globals.css';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Source_Serif_4 } from 'next/font/google';
import { Sidebar } from '../components/Sidebar';
import { ToastProvider } from '../components/Toast';

const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-source-serif'
});

export const metadata = {
  title: 'Status · Rocket Team',
  description: 'Team Claude Code activity and anomaly monitor.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} ${sourceSerif.variable}`}>
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
