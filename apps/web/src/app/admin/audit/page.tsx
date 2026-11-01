import Link from 'next/link';
import type { ReactElement } from 'react';

import { AdminPage } from '../../../components/admin-shell';
import { FieldError, inputClass, labelClass, secondaryButtonClass } from '../../../components/auth-shell';
import { auditExportPath, searchAudit } from '../../../lib/operations-api';
import { csrfFromCookies, loadRoleSession } from '../../../lib/session';

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

interface FilterValues {
  readonly actorId: string;
  readonly action: string;
  readonly from: string;
  readonly to: string;
}

function pageHref(filters: FilterValues, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== '') {
      params.set(key, value);
    }
  }
  if (page > 1) {
    params.set('page', String(page));
  }
  const suffix = params.toString();
  return suffix === '' ? '/admin/audit' : `/admin/audit?${suffix}`;
}

export default async function AuditPage({ searchParams }: PageProps): Promise<ReactElement> {
  const session = await loadRoleSession('/admin/audit', ['ADMIN']);
  const csrf = await csrfFromCookies();
  const params = await searchParams;

  const query = {
    actorId: single(params.actorId).trim(),
    action: single(params.action).trim(),
    from: single(params.from),
    to: single(params.to),
    page: Math.max(1, Number.parseInt(single(params.page), 10) || 1),
  };
  const filters: FilterValues = { actorId: query.actorId, action: query.action, from: query.from, to: query.to };

  const audit = await searchAudit(session.accessToken, query);
  const exportHref = auditExportPath(query);

  return (
    <AdminPage
      csrf={csrf}
      current="/admin/audit"
      title="Audit trail"
      subtitle="Append-only. Nothing here can be edited or deleted, and exporting a copy is itself recorded."
    >
      <FieldError message={single(params.error) === '' ? undefined : single(params.error)} />

      <form method="get" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelClass}>
            Actor id
            <input className={inputClass} name="actorId" type="text" defaultValue={query.actorId} placeholder="uuid" />
          </label>

          <label className={labelClass}>
            Action contains
            <input className={inputClass} name="action" type="text" defaultValue={query.action} placeholder="IDENTITY_" />
          </label>

          <label className={labelClass}>
            From
            <input className={inputClass} name="from" type="date" defaultValue={query.from} />
          </label>

          <label className={labelClass}>
            To
            <input className={inputClass} name="to" type="date" defaultValue={query.to} />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400" type="submit">
            Filter
          </button>
          <Link className={secondaryButtonClass} href={exportHref}>
            Download CSV
          </Link>
        </div>
      </form>

      <p className="text-sm text-slate-400">{audit.total} rows match.</p>

      <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900/60">
        <table data-testid="audit-table" className="w-full min-w-[40rem] text-left text-xs">
          <thead className="bg-slate-900/80 text-slate-400">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Actor</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Entity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {audit.items.map((row) => (
              <tr key={row.id}>
                <td className="px-3 py-2 text-slate-400">{row.occurredAt.replace('T', ' ').slice(0, 19)}</td>
                <td className="px-3 py-2 text-slate-300">{row.actorEmail ?? row.actorUserId ?? '—'}</td>
                <td className="px-3 py-2 text-slate-200">{row.action}</td>
                <td className="px-3 py-2 text-slate-500">
                  {row.entityType ?? '—'}
                  {row.entityId === null ? '' : ` · ${row.entityId.slice(0, 8)}`}
                </td>
              </tr>
            ))}

            {audit.items.length === 0 ? (
              <tr>
                <td className="px-3 py-2 text-slate-400" colSpan={4}>
                  Nothing matches that filter.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <nav className="flex items-center justify-between text-sm text-slate-400">
        {audit.page > 1 ? (
          <Link href={pageHref(filters, audit.page - 1)} className="text-sky-400 hover:text-sky-300">
            Previous
          </Link>
        ) : (
          <span />
        )}
        <span>
          Page {audit.page} of {audit.pages}
        </span>
        {audit.page < audit.pages ? (
          <Link href={pageHref(filters, audit.page + 1)} className="text-sky-400 hover:text-sky-300">
            Next
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </AdminPage>
  );
}
