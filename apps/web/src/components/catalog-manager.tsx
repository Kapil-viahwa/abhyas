import Link from 'next/link';
import type { ReactElement } from 'react';

import type { CatalogTree } from '../lib/catalog';
import { FieldError, Notice, buttonClass, inputClass, labelClass, secondaryButtonClass } from './auth-shell';

/**
 * The catalog tree and the forms that change it, shared by the Administrator and editor
 * areas. The API decides who may change which row; this component only carries the
 * forms, so the same screen is safe in both places.
 *
 * Every row offers the writes the API supports for its kind: edit (name, slug,
 * description and order), move one place up or down among its siblings, activate or
 * deactivate, and delete.
 */

type CatalogType = 'categories' | 'exams' | 'subjects' | 'topics';

interface RowState {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
  /** Present on categories and exams; subjects and topics carry none in the tree. */
  readonly description?: string | null;
}

/** What a move needs to know about a neighbour: its id and the order it currently holds. */
interface Sibling {
  readonly id: string;
  readonly sortOrder: number;
}

interface RowProps {
  readonly csrf: string;
  readonly area: 'admin' | 'editor';
  readonly type: CatalogType;
  readonly row: RowState;
  readonly siblings: readonly Sibling[];
  readonly index: number;
  /** Categories and exams carry a description; subjects and topics do not in the tree. */
  readonly showDescription: boolean;
}

function siblingsOf(rows: readonly RowState[]): Sibling[] {
  return rows.map((row) => ({ id: row.id, sortOrder: row.sortOrder }));
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
  readonly type: CatalogType;
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
  readonly type: CatalogType;
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

/**
 * Moves one row one place up or down. Both order values are sent and the API is asked to
 * give each row the other's: a swap keeps the relative position the person asked for even
 * when both rows currently hold the same order.
 */
function MoveButton({
  csrf,
  area,
  type,
  row,
  direction,
  neighbour,
}: {
  readonly csrf: string;
  readonly area: 'admin' | 'editor';
  readonly type: CatalogType;
  readonly row: RowState;
  readonly direction: 'up' | 'down';
  readonly neighbour: Sibling;
}): ReactElement {
  const label = `Move ${row.name} ${direction}`;

  return (
    <form action="/api/catalog/update" method="post">
      <input type="hidden" name="csrfToken" value={csrf} />
      <input type="hidden" name="area" value={area} />
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="id" value={row.id} />
      <input type="hidden" name="action" value="move" />
      <input type="hidden" name="sortOrder" value={row.sortOrder} />
      <input type="hidden" name="swapId" value={neighbour.id} />
      <input type="hidden" name="swapOrder" value={neighbour.sortOrder} />
      <button className={secondaryButtonClass} type="submit" aria-label={label} title={label}>
        {direction === 'up' ? 'Move up' : 'Move down'}
      </button>
    </form>
  );
}

function CatalogRow({ csrf, area, type, row, siblings, index, showDescription }: RowProps): ReactElement {
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : undefined;

  return (
    <div data-testid="catalog-row" data-name={row.name} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-200">
          {row.name}
          <span className="ml-2 text-xs text-slate-500">{row.isActive ? 'active' : 'inactive'}</span>
          <span className="ml-2 text-xs text-slate-600">order {row.sortOrder}</span>
        </p>

        <div className="flex flex-wrap gap-2">
          {previous === undefined ? null : (
            <MoveButton csrf={csrf} area={area} type={type} row={row} direction="up" neighbour={previous} />
          )}
          {next === undefined ? null : (
            <MoveButton csrf={csrf} area={area} type={type} row={row} direction="down" neighbour={next} />
          )}

          <ActionButton
            csrf={csrf}
            area={area}
            type={type}
            id={row.id}
            action={row.isActive ? 'deactivate' : 'activate'}
            label={row.isActive ? 'Deactivate' : 'Activate'}
          />
          <DeleteButton csrf={csrf} area={area} type={type} id={row.id} />
        </div>
      </div>

      <details>
        <summary className="cursor-pointer text-xs text-sky-400">Edit</summary>
        <form action="/api/catalog/update" method="post" className="mt-2 space-y-3">
          <input type="hidden" name="csrfToken" value={csrf} />
          <input type="hidden" name="area" value={area} />
          <input type="hidden" name="type" value={type} />
          <input type="hidden" name="id" value={row.id} />
          <input type="hidden" name="action" value="edit" />

          <div className="grid gap-3 sm:grid-cols-3">
            <label className={labelClass}>
              Name
              <input className={inputClass} name="name" type="text" defaultValue={row.name} required />
            </label>

            <label className={labelClass}>
              Slug
              <input className={inputClass} name="slug" type="text" defaultValue={row.slug} required />
            </label>

            <label className={labelClass}>
              Order
              <input
                className={inputClass}
                name="sortOrder"
                type="number"
                min={0}
                max={10000}
                defaultValue={row.sortOrder}
                required
              />
            </label>
          </div>

          {showDescription ? (
            <label className={labelClass}>
              Description
              <textarea className={inputClass} name="description" rows={2} defaultValue={row.description ?? ''} />
            </label>
          ) : null}

          <button className={buttonClass} type="submit">
            Save changes
          </button>
        </form>
      </details>
    </div>
  );
}

export function CatalogManager({
  csrf,
  area,
  tree,
  notices,
  error,
}: {
  readonly csrf: string;
  readonly area: 'admin' | 'editor';
  readonly tree: CatalogTree;
  readonly notices: readonly string[];
  readonly error?: string | undefined;
}): ReactElement {
  const roots = tree.categories.filter((category) => category.parentId === null);
  const rootSiblings = siblingsOf(roots);

  /** Exams under one category, each with its subjects and their topics. */
  const examList = (categoryId: string): ReactElement => {
    const exams = tree.exams.filter((exam) => exam.categoryId === categoryId);
    const examSiblings = siblingsOf(exams);

    return (
      <ul className="ml-4 space-y-3 border-l border-slate-800 pl-4">
        {exams.map((exam, examIndex) => (
          <li key={exam.id} className="space-y-2">
            <CatalogRow
              csrf={csrf}
              area={area}
              type="exams"
              row={exam}
              siblings={examSiblings}
              index={examIndex}
              showDescription
            />

            <ul className="ml-4 space-y-3 border-l border-slate-800 pl-4">
              {exam.subjects.map((subject, subjectIndex) => (
                <li key={subject.id} className="space-y-2">
                  <CatalogRow
                    csrf={csrf}
                    area={area}
                    type="subjects"
                    row={subject}
                    siblings={siblingsOf(exam.subjects)}
                    index={subjectIndex}
                    showDescription={false}
                  />

                  <ul className="ml-4 space-y-2 border-l border-slate-800 pl-4">
                    {subject.topics.map((topic, topicIndex) => (
                      <li key={topic.id}>
                        <CatalogRow
                          csrf={csrf}
                          area={area}
                          type="topics"
                          row={topic}
                          siblings={siblingsOf(subject.topics)}
                          index={topicIndex}
                          showDescription={false}
                        />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </li>
        ))}

        {exams.length === 0 ? <li className="text-xs text-slate-500">No exams in this category yet.</li> : null}
      </ul>
    );
  };

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
          <form action="/api/catalog/create" method="post" data-testid="create-form-categories" className="mt-3 space-y-3">
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
          <form action="/api/catalog/create" method="post" data-testid="create-form-exams" className="mt-3 space-y-3">
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
          <form action="/api/catalog/create" method="post" data-testid="create-form-subjects" className="mt-3 space-y-3">
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
          <form action="/api/catalog/create" method="post" data-testid="create-form-topics" className="mt-3 space-y-3">
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
            {roots.map((category, categoryIndex) => {
              const children = tree.categories.filter((row) => row.parentId === category.id);

              return (
                <li key={category.id} className="space-y-3">
                  <CatalogRow
                    csrf={csrf}
                    area={area}
                    type="categories"
                    row={category}
                    siblings={rootSiblings}
                    index={categoryIndex}
                    showDescription
                  />

                  {examList(category.id)}

                  {children.length === 0 ? null : (
                    <ul className="ml-4 space-y-3 border-l border-slate-800 pl-4">
                      {children.map((child, childIndex) => (
                        <li key={child.id} className="space-y-3">
                          <CatalogRow
                            csrf={csrf}
                            area={area}
                            type="categories"
                            row={child}
                            siblings={siblingsOf(children)}
                            index={childIndex}
                            showDescription
                          />

                          {examList(child.id)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="text-xs text-slate-500">
        Public pages:{' '}
        <Link href="/exams" className="text-sky-400 hover:text-sky-300">
          /exams
        </Link>
      </p>
    </div>
  );
}
