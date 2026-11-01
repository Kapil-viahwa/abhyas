import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../lib/authenticated-write';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../lib/route-handler';
import { ACCESS_COOKIE, clearSessionCookies, cookieFromRequest, setSessionCookies } from '../../../../lib/session';
import { apiCall, errorMessage } from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

interface PatchedRow {
  readonly id: string;
}

/** A whole number from a form field, or null when the field does not hold one. */
function wholeNumber(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * The edit form's fields. A description is sent only when the form showed the field:
 * the API reads a missing key as "leave it alone", and subjects and topics do not show
 * one at all.
 */
function editPayload(form: FormData): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: stringField(form, 'name').trim(),
    slug: stringField(form, 'slug').trim(),
    sortOrder: stringField(form, 'sortOrder').trim(),
  };

  if (form.has('description')) {
    payload.description = stringField(form, 'description');
  }

  return payload;
}

/**
 * Change one catalog row: activate or deactivate it, edit it, or move it one place.
 *
 * Ownership is the API's call. A move is two writes — the row takes its neighbour's order
 * and the neighbour takes the row's — because one write cannot swap two values. The first
 * goes through the session helper, so an expired access token is refreshed; the second
 * reuses the token that write actually used.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const area = stringField(guard.form, 'area') === 'editor' ? 'editor' : 'admin';
  const type = stringField(guard.form, 'type').trim();
  const id = stringField(guard.form, 'id').trim();
  const action = stringField(guard.form, 'action').trim();
  const back = `/${area}/catalog`;

  if (id === '') {
    return errorRedirect(back, 'Choose a row to change');
  }

  const endpoint = (targetId: string): string =>
    `/v1/catalog/${encodeURIComponent(type)}/${encodeURIComponent(targetId)}`;

  let payload: Record<string, unknown>;
  let swap: { readonly id: string; readonly body: Record<string, unknown> } | undefined;

  if (action === 'activate' || action === 'deactivate') {
    payload = { isActive: action === 'activate' };
  } else if (action === 'edit') {
    payload = editPayload(guard.form);
  } else if (action === 'move') {
    const mine = wholeNumber(stringField(guard.form, 'currentOrder'));
    const theirs = wholeNumber(stringField(guard.form, 'neighbourOrder'));
    const swapId = stringField(guard.form, 'swapId').trim();

    if (mine === null || theirs === null || swapId === '') {
      return errorRedirect(back, 'That move is missing its place in the list');
    }

    payload = { sortOrder: theirs };
    swap = { id: swapId, body: { sortOrder: mine } };
  } else {
    return errorRedirect(back, 'Unknown action');
  }

  const outcome = await callWithSession(request, (accessToken) =>
    apiCall<PatchedRow>(endpoint(id), { method: 'PATCH', accessToken, body: payload }),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  if (outcome.result.status !== 200) {
    return errorRedirect(back, errorMessage(outcome.result.body));
  }

  if (swap !== undefined) {
    // The token the first write used: a rotated one when the helper refreshed, otherwise
    // the cookie's own. The helper does not hand the token back, so both are read here.
    const token = outcome.tokens?.accessToken ?? cookieFromRequest(request, ACCESS_COOKIE);

    if (token !== undefined && token !== '') {
      const second = await apiCall<PatchedRow>(endpoint(swap.id), {
        method: 'PATCH',
        accessToken: token,
        body: swap.body,
      });

      if (second.status !== 200) {
        return errorRedirect(back, `That row moved, but its neighbour did not: ${errorMessage(second.body)}`);
      }
    }
  }

  const response = redirectTo(`${back}?updated=1`);

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
