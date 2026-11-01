import type { ReactElement } from 'react';

import { AdminPage } from '../../components/admin-shell';
import { FieldError, Notice, buttonClass, inputClass, labelClass } from '../../components/auth-shell';
import { listSettings, settingValue } from '../../lib/operations-api';
import { csrfFromCookies, loadRoleSession } from '../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function bounds(setting: { minInt: number | null; maxInt: number | null }): string {
  if (setting.minInt === null && setting.maxInt === null) {
    return 'no bounds';
  }
  return `${setting.minInt ?? '−∞'} to ${setting.maxInt ?? '∞'}`;
}

export default async function SettingsPage({ searchParams }: PageProps): Promise<ReactElement> {
  const session = await loadRoleSession('/admin/settings', ['ADMIN']);
  const csrf = await csrfFromCookies();
  const settings = await listSettings(session.accessToken);
  const params = await searchParams;

  return (
    <AdminPage
      csrf={csrf}
      current="/admin/settings"
      title="Settings"
      subtitle="Every change is bounded by the row itself and recorded in the audit trail."
    >
      <Notice message={params.updated === '1' ? 'Setting saved.' : undefined} />
      <FieldError message={typeof params.error === 'string' ? params.error : undefined} />

      <ul data-testid="settings-list" className="space-y-3">
        {settings.map((setting) => (
          <li key={setting.key} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-medium text-slate-100">{setting.key}</h2>
              <p className="text-xs text-slate-500">
                {setting.valueType} · {bounds(setting)}
              </p>
            </div>

            {setting.description === null ? null : (
              <p className="mt-1 text-xs text-slate-400">{setting.description}</p>
            )}

            <form action="/api/admin/settings" method="post" className="mt-3 flex flex-wrap items-end gap-3">
              <input type="hidden" name="csrfToken" value={csrf} />
              <input type="hidden" name="key" value={setting.key} />

              <label className={`${labelClass} min-w-[8rem] grow`}>
                Value
                {setting.valueType === 'boolean' ? (
                  <select className={inputClass} name="value" defaultValue={settingValue(setting)}>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    className={inputClass}
                    name="value"
                    type={setting.valueType === 'integer' ? 'number' : 'text'}
                    defaultValue={settingValue(setting)}
                    min={setting.minInt ?? undefined}
                    max={setting.maxInt ?? undefined}
                    required
                  />
                )}
              </label>

              <button className={`${buttonClass} sm:w-auto`} type="submit">
                Save
              </button>
            </form>
          </li>
        ))}
      </ul>

      {settings.length === 0 ? <p className="text-sm text-slate-400">No settings are defined.</p> : null}
    </AdminPage>
  );
}
