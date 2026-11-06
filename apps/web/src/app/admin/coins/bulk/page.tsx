import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import type { ReactElement } from 'react';

import { AdminPage } from '../../../../components/admin-shell';
import { FieldError, Notice, buttonClass, inputClass, labelClass, secondaryButtonClass } from '../../../../components/auth-shell';
import { BULK_DRAFT_MAX_AGE_SECONDS, BULK_DRAFT_MAX_BYTES, readBulkDraft } from '../../../../lib/coin-bulk';
import { isUuid } from '../../../../lib/coins-api';
import { csrfFromCookies, loadPermissionSession } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return '';
}

function minutes(): number {
  return Math.round(BULK_DRAFT_MAX_AGE_SECONDS / 60);
}

/**
 * Credit many accounts from one CSV: preview first, then confirm.
 *
 * The preview is a draft in one httpOnly cookie, and it is convenience only: confirming
 * posts the matched ids back to the API, which re-reads each account and moves the coins
 * itself. The Idempotency-Key is generated once, when the preview is rendered, so a double
 * click on confirm creates one job.
 */
export default async function BulkCoinsPage({ searchParams }: PageProps): Promise<ReactElement> {
  const session = await loadPermissionSession('/admin/coins/bulk', 'coins.write');
  const csrf = await csrfFromCookies();
  const params = await searchParams;

  const startOver = single(params.new) === '1';
  const stored = await readBulkDraft();
  const draft = startOver ? null : stored;
  const requestedKey = single(params.key).trim();
  const confirmKey = isUuid(requestedKey) ? requestedKey : randomUUID();
  const needsProof = single(params.reauth) === '1';

  return (
    <AdminPage
      csrf={csrf}
      permissions={session.profile.permissions}
      current="/admin/coins"
      title="Bulk assignment"
      subtitle="One CSV, one amount and one reason: preview who it reaches, then confirm."
    >
      <FieldError message={single(params.error) === '' ? undefined : single(params.error)} />
      {needsProof ? (
        <Notice message="That submission was not saved. Confirm it is you below and send it again — the same request is kept." />
      ) : null}

      {draft === null ? (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
          <h2 className="text-lg font-medium text-slate-100">Upload</h2>
          <p className="mt-1 text-sm text-slate-400">
            The first column is an email address or a mobile number. A header row is skipped, blanks are ignored and
            repeats are counted once. At most 500 rows at a time.
          </p>

          <form
            action="/api/admin/coins/bulk/preview"
            method="post"
            encType="multipart/form-data"
            className="mt-4 grid gap-3 sm:grid-cols-2"
          >
            <input type="hidden" name="csrfToken" value={csrf} />

            <label className={`${labelClass} sm:col-span-2`}>
              CSV file
              <input className={inputClass} type="file" name="csv" accept=".csv,text/csv" required />
            </label>

            <label className={labelClass}>
              Coins per account
              <input className={inputClass} name="amount" type="number" min={1} step={1} required />
            </label>

            <label className={labelClass}>
              Reason (required)
              <input className={inputClass} name="remark" type="text" required minLength={3} maxLength={200} />
            </label>

            <div className="sm:col-span-2">
              <button className={`${buttonClass} sm:w-auto`} type="submit">
                Preview
              </button>
            </div>
          </form>
        </section>
      ) : (
        <>
          <section data-testid="bulk-preview" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
            <h2 className="text-lg font-medium text-slate-100">Preview</h2>
            <p className="mt-1 text-sm text-slate-300">
              <strong>{draft.totalCoins.toLocaleString('en-IN')}</strong> coins across{' '}
              <strong>{draft.matched.length}</strong> accounts, {draft.amount.toLocaleString('en-IN')} each. Reason:{' '}
              {draft.remark}
            </p>

            <div className="mt-4 overflow-x-auto">
              <table data-testid="bulk-matched" className="w-full min-w-[420px] text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2">Account</th>
                    <th className="py-2 text-right">Coins</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {draft.matched.map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 text-slate-200">{row.label}</td>
                      <td className="py-2 text-right text-emerald-300">+{draft.amount.toLocaleString('en-IN')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div data-testid="bulk-unmatched" className="mt-4 text-sm">
              <h3 className="text-xs uppercase tracking-wide text-slate-500">Not found ({draft.unmatched.length})</h3>
              {draft.unmatched.length === 0 ? (
                <p className="mt-1 text-slate-400">Every row matched an account.</p>
              ) : (
                <ul className="mt-1 space-y-1 text-amber-300">
                  {draft.unmatched.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
            <h2 className="text-lg font-medium text-slate-100">Confirm</h2>
            <p className="mt-1 text-sm text-slate-400">
              Only the {draft.matched.length} matched accounts are credited; the rows above that matched nothing are
              reported and skipped. The preview is kept for {minutes()} minutes.
            </p>

            <form action="/api/admin/coins/bulk/confirm" method="post" className="mt-4 grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="csrfToken" value={csrf} />
              <input type="hidden" name="idempotencyKey" value={confirmKey} />

              <label className={labelClass}>
                Your password
                <input className={inputClass} name="password" type="password" autoComplete="current-password" />
              </label>

              <label className={labelClass}>
                Or the code you were sent
                <input className={inputClass} name="code" inputMode="numeric" autoComplete="one-time-code" />
              </label>

              <div className="flex flex-wrap gap-3 sm:col-span-2">
                <button className={`${buttonClass} sm:w-auto`} type="submit">
                  Credit {draft.matched.length} accounts
                </button>
                <Link className={secondaryButtonClass} href="/admin/coins/bulk?new=1">
                  Start over
                </Link>
              </div>
            </form>
          </section>
        </>
      )}

      {stored !== null && draft === null && !startOver ? (
        <Notice
          message={`That preview is older than ${String(minutes())} minutes and was not kept. Upload the file again.`}
        />
      ) : null}

      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/admin/coins" className="text-sky-400 hover:text-sky-300">
          Search an account
        </Link>
        <Link href="/admin" className="text-sky-400 hover:text-sky-300">
          Back to administration
        </Link>
      </div>
      <p className="text-xs text-slate-600">A draft is at most {BULK_DRAFT_MAX_BYTES.toLocaleString('en-IN')} bytes.</p>
    </AdminPage>
  );
}
