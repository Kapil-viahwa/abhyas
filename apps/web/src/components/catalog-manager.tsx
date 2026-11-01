import Link from 'next/link';
import type { ReactElement } from 'react';

import type { CatalogTree } from '../lib/catalog';
import { FieldError, Notice, buttonClass, inputClass, labelClass, secondaryButtonClass } from './auth-shell';

/**
 * The catalog tree and the forms that change it, shared by the Administrator and editor
 * areas. The API decides who may change which row; this component only carries the
 * forms, so the same screen is safe in both places.
 */

interface CatalogManagerProps {
  readonly csrf: string;
  readonly area: 'admin' | 'editor';
  readonly tree: CatalogTree;
  readonly notices: readonly string[];
  readonly error?: string | undefined;
}

function ActionButton({
  csrf,
  area,
  type,
  id,
  action,
  label,
}: {
  readonly csrf: string;
  readonly area: 'admin' | 'editor';
  readonly type: string;
  readonly id: string;
  readonly action: string;
  readonly label: string;
}): ReactElement {
  return (
    <form action="/api/catalog/update" method="post">
      <input type="hidden" name="csrfToken" value={csrf} />
      <input type="hidden" name="area" value={area} />
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="action" value={action} />
      <button className={secondaryButtonClass} type="submit">
        {label}
      </button>
    </form>
  );
}

function DeleteButton({
  csrf,
  area,
  type,
  id,
}: {
  readonly csrf: string;
  readonly area: 'admin' | 'editor';
  readonly type: string;
  readonly id: string;
}): ReactElement {
  return (
    <form action="/api/catalog/delete" method="post">
      <input type="hidden" name="csrfToken" value={csrf} />
      <input type="hidden" name="area" value={area} />
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="id" value={id} />
      <button className={secondaryButtonClass} type="submit">
        Delete
      </button>
    </form>
  );
}

export function CatalogManager({ csrf, area, tree, notices, error }: CatalogManagerProps): ReactElement {
  const roots = tree.categories.filter((category) => category.parentId === null);

  return (
    <div className="space-y-6">
      {notices.map((notice) => (
        <Notice key={notice} message={notice} />
      ))}
      <FieldError message={error} />

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
        <h2 className="text-lg font-medium text-slate-100">Create</h2>

        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-sky-400">Category</summary>
          <form action="/api/catalog/create" method="post" className="mt-3 space-y-3">
            <input type="hidden" name="csrfToken" value={csrf} />
            <input type="hidden" name="area" value={area} />
            <input type="hidden" name="type" value="categories" />

            <label className={labelClass}>
              Name
              <input className={inputClass} name="name" type="text" required />
            </label>

            <label className={labelClass}>
              Parent category (optional)
              <select className={inputClass} name="parentId" defaultValue="">
                <option value="">None — a top-level category</option>
                {roots.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>

            <button className={buttonClass} type="submit">
              Create category
            </button>
          </form>
        </details>

        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-sky-400">Exam</summary>
          <form action="/api/catalog/create" method="post" className="mt-3 space-y-3">
            <input type="hidden" name="csrfToken" value={csrf} />
            <input type="hidden" name="area" value={area} />
            <input type="hidden" name="type" value="exams" />

            <label className={labelClass}>
              Name
              <input className={inputClass} name="name" type="text" required />
            </label>

            <label className={labelClass}>
              Category
              <select className={inputClass} name="categoryId" required>
                {tree.categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.parentId === null ? category.name : `— ${category.name}`}
                  </option>
                ))}
              </select>
            </label>

            <button className={buttonClass} type="submit">
              Create exam
            </button>
          </form>
        </details>

        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-sky-400">Subject</summary>
          <form action="/api/catalog/create" method="post" className="mt-3 space-y-3">
            <input type="hidden" name="csrfToken" value={csrf} />
            <input type="hidden" name="area" value={area} />
            <input type="hidden" name="type" value="subjects" />

            <label className={labelClass}>
              Name
              <input className={inputClass} name="name" type="text" required />
            </label>

            <label className={labelClass}>
              Exam
              <select className={inputClass} name="examId" required>
                {tree.exams.map((exam) => (
                  <option key={exam.id} value={exam.id}>
                    {exam.name}
                  </option>
                ))}
              </select>
            </label>

            <button className={buttonClass} type="submit">
              Create subject
            </button>
          </form>
        </details>

        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-sky-400">Topic</summary>
          <form action="/api/catalog/create" method="post" className="mt-3 space-y-3">
            <input type="hidden" name="csrfToken" value={csrf} />
            <input type="hidden" name="area" value={area} />
            <input type="hidden" name="type" value="topics" />

            <label className={labelClass}>
              Name
              <input className={inputClass} name="name" type="text" required />
            </label>

            <label className={labelClass}>
              Subject
              <select className={inputClass} name="subjectId" required>
                {tree.exams.flatMap((exam) =>
                  exam.subjects.map((subject) => (
                    <option key={subject.id} value={subject.id}>
                      {exam.name} — {subject.name}
                    </option>
                  )),
                )}
              </select>
            </label>

            <button className={buttonClass} type="submit">
              Create topic
            </button>
          </form>
        </details>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
        <h2 className="text-lg font-medium text-slate-100">Tree</h2>

        {tree.categories.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No categories yet. Create one above.</p>
        ) : (
          <ul data-testid="catalog-tree" className="mt-3 space-y-4">
            {roots.map((category) => {
              const children = tree.categories.filter((row) => row.parentId === category.id);
              const categoryIds = new Set([category.id, ...children.map((child) => child.id)]);
              const exams = tree.exams.filter((exam) => categoryIds.has(exam.categoryId));

              return (
                <li key={category.id} className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-slate-200">
                      {category.name}
                      <span className="ml-2 text-xs text-slate-500">{category.isActive ? 'active' : 'inactive'}</span>
                    </p>
                    <div className="flex gap-2">
                      <ActionButton
                        csrf={csrf}
                        area={area}
                        type="categories"
                        id={category.id}
                        action={category.isActive ? 'deactivate' : 'activate'}
                        label={category.isActive ? 'Deactivate' : 'Activate'}
                      />
                      <DeleteButton csrf={csrf} area={area} type="categories" id={category.id} />
                    </div>
                  </div>

                  <ul className="ml-4 space-y-2 border-l border-slate-800 pl-4">
                    {children.map((child) => (
                      <li key={child.id} className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs text-slate-400">
                          {child.name}
                          <span className="ml-2">{child.isActive ? 'active' : 'inactive'}</span>
                        </p>
                        <ActionButton
                          csrf={csrf}
                          area={area}
                          type="categories"
                          id={child.id}
                          action={child.isActive ? 'deactivate' : 'activate'}
                          label={child.isActive ? 'Deactivate' : 'Activate'}
                        />
                      </li>
                    ))}

                    {exams.map((exam) => (
                      <li key={exam.id} className="space-y-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs text-slate-300">
                            {exam.name}
                            <span className="ml-2 text-slate-500">{exam.isActive ? 'active' : 'inactive'}</span>
                          </p>
                          <div className="flex gap-2">
                            <ActionButton
                              csrf={csrf}
                              area={area}
                              type="exams"
                              id={exam.id}
                              action={exam.isActive ? 'deactivate' : 'activate'}
                              label={exam.isActive ? 'Deactivate' : 'Activate'}
                            />
                            <DeleteButton csrf={csrf} area={area} type="exams" id={exam.id} />
                            <Link
                              href={`/exams/${tree.categories.find((row) => row.id === exam.categoryId)?.slug ?? ''}/${exam.slug}`}
                              className="text-xs text-sky-400 hover:text-sky-300"
                            >
                              Public page
                            </Link>
                          </div>
                        </div>

                        {exam.subjects.length > 0 ? (
                          <ul className="ml-3 space-y-1 text-xs text-slate-500">
                            {exam.subjects.map((subject) => (
                              <li key={subject.id}>
                                {subject.name}
                                {subject.topics.length === 0
                                  ? ''
                                  : ` · ${subject.topics.map((topic) => topic.name).join(', ')}`}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
