import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import { AdminPage } from '../../../../../components/admin-shell';
import { Notice, secondaryButtonClass } from '../../../../../components/auth-shell';
import { bulkJob, bulkReportPath } from '../../../../../lib/coins-api';
import { csrfFromCookies, loadPermissionSession } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ id: string }>;
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

function formatNumber(value: number): string {
  return value.toLocaleString('en-IN');
}

function formatMoment(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'unknown'
    : date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

function statusLabel(status: string): string {
  if (status === 'PENDING') {
    return 'Not credited yet';
  }
  return status === 'CREDITED' ? 'Credited' : 'Failed';
}

/** One bulk assignment: what it did to each account, and the report. */
export default async function BulkJobPage({ params, searchParams }: PageProps): Promise<ReactElement> {
  const { id } = await params;
  const session = await loadPermissionSession(`/admin/coins/bulk/${id}`, 'coins.write');
  const csrf = await csrfFromCookies();
  const query = await searchParams;
  const job = await bulkJob(session.accessToken, id);

  if (job === null) {
    notFound();
  }

  const pending = job.status === 'QUEUED' || job.status === 'RUNNING';

  return (
    <AdminPage
      csrf={csrf}
      permissions={session.profile.permissions}
      current="/admin/coins"
      title="Bulk assignment"
      subtitle={`${formatNumber(job.amount)} coins per account · ${job.remark} · ${formatMoment(job.createdAt)}`}
    >
      {/* Until the worker is done this screen reloads itself; a manual Refresh link sits beside it. */}
      {pending ? <meta httpEquiv="refresh" content="5" /> : null}

      <Notice
        message={single(query.started) === '1' ? 'Job started. The worker credits each account in turn.' : undefined}
      />

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <p className="text-xs uppercase tracking-wide text-slate-500">Status</p>
          <p data-testid="bulk-status" className="mt-2 text-lg font-semibold text-white">
            {job.status}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <p className="text-xs uppercase tracking-wide text-slate-500">Credited</p>
          <p data-testid="bulk-credited" className="mt-2 text-lg font-semibold text-emerald-300">
            {formatNumber(job.creditedUsers)} / {formatNumber(job.totalUsers)}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <p className="text-xs uppercase tracking-wide text-slate-500">Failed</p>
          <p data-testid="bulk-failed" className="mt-2 text-lg font-semibold text-rose-300">
            {formatNumber(job.failedUsers)}
          </p>
        </div>
      </section>

      {pending ? (
        <p className="text-sm text-slate-400">
          The worker credits each account within half a minute. This page reloads itself until it is done.{' '}
          <Link href={`/admin/coins/bulk/${job.id}`} className="text-sky-400 hover:text-sky-300">
            Refresh now
          </Link>
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900/60">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="p-3">Account</th>
              <th className="p-3">Status</th>
              <th className="p-3">Coins</th>
              <th className="p-3">Note</th>
            </tr>
          </thead>
          <tbody data-testid="bulk-rows" className="divide-y divide-slate-800">
            {job.rows.map((row) => (
              <tr key={row.userId}>
                <td className="p-3 text-slate-200">{row.email ?? row.userId}</td>
                <td className="p-3 text-slate-300">{statusLabel(row.status)}</td>
                <td className="p-3 text-slate-300">
                  {row.status === 'CREDITED' ? `+${formatNumber(job.amount)}` : '—'}
                </td>
                <td className="p-3 text-slate-500">{row.errorMessage ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Link className={secondaryButtonClass} href={bulkReportPath(job.id)}>
          Download report
        </Link>
        <Link href="/admin/coins/bulk" className="text-sky-400 hover:text-sky-300">
          Another bulk assignment
        </Link>
        <Link href="/admin/coins" className="text-sky-400 hover:text-sky-300">
          Search an account
        </Link>
      </div>
    </AdminPage>
  );
}
