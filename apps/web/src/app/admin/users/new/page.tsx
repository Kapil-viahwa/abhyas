import type { ReactElement } from 'react';

import { AdminPage } from '../../../../components/admin-shell';
import { FieldError, buttonClass, inputClass, labelClass } from '../../../../components/auth-shell';
import { csrfFromCookies, loadRoleSession } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const FLAG_FIELDS = [
  {
    name: 'manage_questions',
    label: 'Manage questions',
    hint: 'Create and edit exams, subjects, topics, questions and options',
  },
  { name: 'manage_tests', label: 'Manage tests', hint: 'Create and edit tests, sections and question placement' },
  { name: 'publish_tests', label: 'Publish tests', hint: 'Publish or archive a test' },
] as const;

export default async function NewEditorPage({ searchParams }: PageProps): Promise<ReactElement> {
  await loadRoleSession('/admin/users/new', ['ADMIN']);
  const csrf = await csrfFromCookies();
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;

  return (
    <AdminPage
      csrf={csrf}
      current="/admin/users/new"
      title="Create an editor"
      subtitle="Capabilities are explicit: a box that is not ticked is not granted."
    >
      <FieldError message={error} />

      <form
        action="/api/admin/users/editors"
        method="post"
        className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6"
      >
        <input type="hidden" name="csrfToken" value={csrf} />

        <label className={labelClass}>
          Full name
          <input className={inputClass} name="fullName" type="text" autoComplete="off" required />
        </label>

        <label className={labelClass}>
          Email
          <input className={inputClass} name="email" type="email" autoComplete="off" required />
        </label>

        <label className={labelClass}>
          Initial password
          <input className={inputClass} name="password" type="password" autoComplete="new-password" required />
          <span className="mt-1 block text-xs text-slate-500">
            At least 12 characters with a letter and a digit. The editor can change it after signing in.
          </span>
        </label>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-300">Capabilities</legend>

          {FLAG_FIELDS.map((field) => (
            <label key={field.name} className="flex items-start gap-3 text-sm text-slate-300">
              <input className="mt-1" type="checkbox" name={field.name} value="on" />
              <span>
                {field.label}
                <span className="block text-xs text-slate-500">{field.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <button className={buttonClass} type="submit">
          Create editor
        </button>
      </form>
    </AdminPage>
  );
}
