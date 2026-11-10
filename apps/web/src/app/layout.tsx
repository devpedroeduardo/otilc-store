import type { Metadata, Viewport } from 'next';
import { CartProvider } from '@/components/cart-context';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'OTILC · Veja além', template: '%s · OTILC' },
  description: 'Loja da OTILC. Peças selecionadas, com estoque em tempo real e pagamento via Pix.',
  icons: { icon: '/brand/favicon-32.png', apple: '/brand/apple-touch-icon.png' },
};

export const viewport: Viewport = { themeColor: '#09090a' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..100,400..900&family=Instrument+Serif:ital@0;1&family=Space+Mono:wght@400;700&display=swap"
        />
      </head>
      <body>
        <CartProvider>{children}</CartProvider>
      </body>
    </html>
  );
}
