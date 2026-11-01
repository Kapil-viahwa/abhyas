'use client';

import { useEffect, useRef, useState } from 'react';

import { TURNSTILE_TEST_TOKEN } from '../lib/config';

interface TurnstileWindow {
  turnstile?: {
    render(container: HTMLElement, options: { sitekey: string; callback: (token: string) => void }): string;
  };
}

/**
 * The human check.
 *
 * A real Cloudflare widget is always rendered with the configured site key. While that
 * key is one of Cloudflare's always-pass test keys (development and CI only — production
 * refuses them), the hidden field is pre-filled with the token the API's test verifier
 * accepts, so the flow does not depend on challenges.cloudflare.com being reachable
 * from a CI runner. A real key never pre-fills anything.
 */
export function TurnstileField({ siteKey, testMode }: { readonly siteKey: string; readonly testMode: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState(testMode ? TURNSTILE_TEST_TOKEN : '');

  useEffect(() => {
    const mount = container.current;
    if (mount === null) {
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => {
      (window as unknown as TurnstileWindow).turnstile?.render(mount, {
        sitekey: siteKey,
        callback: (value: string) => {
          // In test mode the API's verifier only knows the fixed development token, so
          // the widget is shown but never replaces it. A real site key always wins.
          if (!testMode) {
            setToken(value);
          }
        },
      });
    };
    document.head.appendChild(script);

    return () => {
      script.remove();
    };
  }, [siteKey]);

  return (
    <div className="space-y-2">
      <input type="hidden" name="turnstileToken" value={token} />
      <div ref={container} data-testid="turnstile-widget" />
      {testMode ? <p className="text-xs text-slate-500">Human check is in test mode.</p> : null}
    </div>
  );
}
