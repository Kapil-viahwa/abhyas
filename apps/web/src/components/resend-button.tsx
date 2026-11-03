'use client';

import { useEffect, useState } from 'react';

/**
 * The resend countdown.
 *
 * The API refuses a second code before its cooldown has passed and says how long is left,
 * so the button starts from that number and counts down. It is a plain disabled button with
 * `formAction`: submitting the same form again asks for a new code, and nothing is sent by
 * a script on its own.
 */
export function ResendButton({
  action,
  seconds,
  label = 'Resend code',
}: {
  readonly action: string;
  readonly seconds: number;
  readonly label?: string;
}) {
  const [left, setLeft] = useState(seconds);

  useEffect(() => {
    if (left <= 0) {
      return undefined;
    }

    const timer = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);

  return (
    <button
      className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
      data-testid="resend-code"
      disabled={left > 0}
      formAction={action}
      type="submit"
    >
      {left > 0 ? `Resend in ${String(left)}s` : label}
    </button>
  );
}
