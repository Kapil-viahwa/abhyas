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
    // In test mode the token is the fixed development one and the widget cannot change it, so
    // loading Cloudflare's script would only add an iframe that grows the page after it renders
    // (and the console error the always-pass test key produces). A real site key always renders
    // the widget.
    if (testMode) {
      return undefined;
    }

    const mount = container.current;
    if (mount === null) {
      return undefined;
    }

    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => {
      (window as unknown as TurnstileWindow).turnstile?.render(mount, {
        sitekey: siteKey,
        callback: (value: string) => {
          setToken(value);
        },
      });
    };
    document.head.appendChild(script);

    return () => {
      script.remove();
    };
  }, [siteKey, testMode]);

  return (
    <div className="space-y-2">
      <input type="hidden" name="turnstileToken" value={token} />
      {testMode ? (
        <p className="text-xs text-slate-500">Human check is in test mode.</p>
      ) : (
        // The widget is an iframe about 65px tall that appears only once Cloudflare's script
        // loads. Reserving that height keeps the form below it still while it renders.
        <div ref={container} data-testid="turnstile-widget" className="min-h-[65px]" />
      )}
    </div>
  );
}
