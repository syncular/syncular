import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import type { Metadata } from 'next';
import { Inter, Inter_Tight, JetBrains_Mono, Syne } from 'next/font/google';

const inter = Inter({
  subsets: ['latin'],
});

const syne = Syne({
  subsets: ['latin'],
  variable: '--font-syne',
});

const interTight = Inter_Tight({
  subsets: ['latin'],
  variable: '--font-inter-tight',
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://docs.syncular.dev'),
  icons: {
    icon: [
      { url: '/assets/favicon-96x96.png', sizes: '96x96', type: 'image/png' },
      { url: '/assets/favicon.svg', type: 'image/svg+xml' },
    ],
    shortcut: '/assets/favicon.ico',
    apple: [{ url: '/assets/apple-touch-icon.png', sizes: '180x180' }],
  },
  manifest: '/assets/site.webmanifest',
  appleWebApp: {
    title: 'Syncular',
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.className} ${syne.variable} ${interTight.variable} ${jetBrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider
          theme={{
            defaultTheme: 'dark',
            enableSystem: false,
            forcedTheme: 'dark',
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
