'use client';

import { useEffect } from 'react';

/**
 * Submits the form with this id as soon as the page renders, so following a link from an
 * email finishes the action without a second click. A `noscript` button in the page
 * covers the case where JavaScript never runs.
 */
export function AutoSubmit({ formId }: { readonly formId: string }) {
  useEffect(() => {
    const form = document.getElementById(formId);
    if (form instanceof HTMLFormElement) {
      form.requestSubmit();
    }
  }, [formId]);

  return null;
}
