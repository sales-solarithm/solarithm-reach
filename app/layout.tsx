import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { ThemeProvider } from '@/components/ThemeProvider';
import { AuthProvider } from '@/context/AuthContext';

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  weight: ['400', '500', '600', '700'],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'Solarithm Reach',
  description:
    'Enterprise telecalling and sales lead management console for high-volume solar sales pipelines.',
  openGraph: {
    title: 'Solarithm Reach',
    description:
      'Enterprise telecalling and sales lead management console for high-volume solar sales pipelines.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Solarithm Reach',
    description:
      'Enterprise telecalling and sales lead management console for high-volume solar sales pipelines.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${jakarta.variable} ${jetbrainsMono.variable}`}>
      <body suppressHydrationWarning className="font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
