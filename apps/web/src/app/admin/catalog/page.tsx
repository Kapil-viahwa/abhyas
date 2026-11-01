import type { ReactElement } from 'react';

import { AdminPage } from '../../../components/admin-shell';
import { CatalogManager } from '../../../components/catalog-manager';
import { getCatalogTree } from '../../../lib/catalog';
import { csrfFromCookies, loadRoleSession } from '../../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** The Administrator's catalog screen. Every row is editable, because an admin owns all of it. */
export default async function AdminCatalogPage({ searchParams }: PageProps): Promise<ReactElement> {
  const session = await loadRoleSession('/admin/catalog', ['ADMIN']);
  const csrf = await csrfFromCookies();
  const tree = await getCatalogTree(session.accessToken);
  const params = await searchParams;

  const notices: string[] = [];
  if (params.created === '1') {
    notices.push('Created.');
  }
  if (params.updated === '1') {
    notices.push('Updated.');
  }
  if (params.deleted === '1') {
    notices.push('Deleted.');
  }

  return (
    <AdminPage
      csrf={csrf}
      current="/admin/catalog"
      title="Catalog"
      subtitle="Categories, exams, subjects and topics. Every write reaches the public pages after revalidation."
    >
      <CatalogManager
        csrf={csrf}
        area="admin"
        tree={tree}
        notices={notices}
        error={typeof params.error === 'string' ? params.error : undefined}
      />
    </AdminPage>
  );
}
