import './globals.css';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Source_Serif_4 } from 'next/font/google';
import { Sidebar } from '../components/Sidebar';
import { ToastProvider } from '../components/Toast';
import { NewTaskProvider } from '../components/NewTaskModal';
import { listAgents } from '@/lib/agents';

const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-source-serif'
});

export const metadata = {
  title: 'Rocket Team · 团队协作分工',
  description: '通过 agent 推演团队成员对每项任务的协作意见，把任务最终分给真人。'
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let agentCount = 0;
  try {
    const names = await listAgents();
    agentCount = names.length;
  } catch {
    agentCount = 0;
  }
  return (
    <html lang="zh-CN" className={`${GeistSans.variable} ${GeistMono.variable} ${sourceSerif.variable}`}>
      <body className="font-sans bg-paper">
        <ToastProvider>
          <NewTaskProvider>
            <div className="flex min-h-screen">
              <Sidebar memberCount={agentCount} />
              <main className="flex-1 min-w-0 relative">{children}</main>
            </div>
          </NewTaskProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
