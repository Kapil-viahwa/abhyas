import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'Abhyas',
  description: "Mock tests for India's competitive exams",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {/* The first focusable thing on every page, hidden until it is focused: every shell puts the
            navigation before the page content, so a keyboard user skips it in one Tab. It targets the
            single `<main id="main">` each page renders. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-sky-500 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-slate-950"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
