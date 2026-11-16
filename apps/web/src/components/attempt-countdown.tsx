'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import { formatCountdown } from '../lib/countdown';

/**
 * Phase 7, A4: a countdown on the result page while the attempt is still running.
 *
 * It displays the server's remaining seconds and nothing else: one offset from
 * `performance.now()` at render, never the device clock, so changing the device clock changes
 * nothing. When it reaches zero it asks the server-rendered page to render again once — the
 * server, not this component, decides whether the attempt has ended.
 */
export function AttemptCountdown({ remainingSeconds }: { readonly remainingSeconds: number }): ReactElement {
  const router = useRouter();
  const [seconds, setSeconds] = useState(remainingSeconds);
  const deadlineMono = useRef(0);
  const refreshed = useRef(false);

  useEffect(() => {
    deadlineMono.current = performance.now() + Math.max(0, remainingSeconds) * 1000;
    setSeconds(Math.max(0, Math.floor(remainingSeconds)));

    const timer = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((deadlineMono.current - performance.now()) / 1000));
      setSeconds(left);

      if (left === 0 && !refreshed.current) {
        refreshed.current = true;
        router.refresh();
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [remainingSeconds, router]);

  return (
    <span data-testid="attempt-countdown" className="font-mono text-base text-white">
      {formatCountdown(seconds)}
    </span>
  );
}
