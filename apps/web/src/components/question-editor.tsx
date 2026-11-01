'use client';

import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import katex from 'katex';
import { useMemo, useState, type ReactElement } from 'react';

import { buttonClass, inputClass, labelClass, secondaryButtonClass } from './auth-shell';
import type { CatalogChoices, QuestionDraftPayload, QuestionView } from '../lib/questions-api';

/**
 * The authoring form. TipTap produces the HTML; the server sanitises it again, because
 * this component runs in a browser and a browser can be wrong on purpose.
 *
 * The preview panel is the student view: the same markup, and the LaTeX rendered by
 * KaTeX with `trust` disabled so a `\href` cannot become a link.
 */

interface OptionDraft {
  optionHtml: string;
  isCorrect: boolean;
  imageId: string;
}

interface Props {
  readonly action: string;
  readonly csrfToken: string;
  readonly catalog: CatalogChoices;
  readonly question: QuestionView | null;
  readonly cancelHref: string;
}

function renderLatex(latex: string): string {
  if (latex.trim() === '') {
    return '';
  }
  try {
    return katex.renderToString(latex, { throwOnError: false, trust: false, strict: 'ignore', displayMode: true });
  } catch {
    return '';
  }
}

export function QuestionEditor({ action, csrfToken, catalog, question, cancelHref }: Props): ReactElement {
  const [examId, setExamId] = useState(question?.examId ?? catalog.exams[0]?.id ?? '');
  const [subjectId, setSubjectId] = useState(question?.subjectId ?? '');
  const [topicId, setTopicId] = useState(question?.topicId ?? '');
  const [questionType, setQuestionType] = useState(question?.version.questionType ?? 'MCQ');
  const [language, setLanguage] = useState(question?.version.language ?? 'EN');
  const [difficulty, setDifficulty] = useState(question?.version.difficulty ?? 'MEDIUM');
  const [marks, setMarks] = useState(question?.version.marks ?? '1');
  const [negativeMarks, setNegativeMarks] = useState(question?.version.negativeMarks ?? '0');
  const [numericalAnswer, setNumericalAnswer] = useState(question?.version.numericalAnswer ?? '');
  const [latex, setLatex] = useState(question?.version.latex ?? '');
  const [options, setOptions] = useState<OptionDraft[]>(
    question !== null && question.options.length > 0
      ? question.options.map((option) => ({
          optionHtml: option.optionHtml,
          isCorrect: option.isCorrect,
          imageId: option.imageId ?? '',
        }))
      : [
          { optionHtml: '', isCorrect: true, imageId: '' },
          { optionHtml: '', isCorrect: false, imageId: '' },
        ],
  );

  const content = useEditor({
    extensions: [StarterKit],
    content: question?.version.contentHtml ?? '<p></p>',
    immediatelyRender: false,
    editorProps: { attributes: { class: 'min-h-24 rounded-xl border border-slate-800 bg-slate-950/80 p-3 text-sm text-slate-100' } },
  });

  const explanation = useEditor({
    extensions: [StarterKit],
    content: question?.version.explanationHtml ?? '<p></p>',
    immediatelyRender: false,
    editorProps: { attributes: { class: 'min-h-16 rounded-xl border border-slate-800 bg-slate-950/80 p-3 text-sm text-slate-100' } },
  });

  const subjects = useMemo(() => catalog.subjects.filter((subject) => subject.examId === examId), [catalog.subjects, examId]);
  const topics = useMemo(
    () => catalog.topics.filter((topic) => topic.subjectId === subjectId),
    [catalog.topics, subjectId],
  );

  const payload: QuestionDraftPayload = {
    examId,
    subjectId,
    topicId: topicId === '' ? null : topicId,
    questionType,
    language,
    difficulty,
    contentHtml: content?.getHTML() ?? '',
    explanationHtml: explanation?.getHTML() ?? '',
    latex: latex.trim() === '' ? null : latex,
    numericalAnswer: questionType === 'NUMERICAL' ? numericalAnswer : null,
    marks,
    negativeMarks,
    options:
      questionType === 'MCQ'
        ? options.map((option) => ({
            optionHtml: option.optionHtml,
            isCorrect: option.isCorrect,
            imageId: option.imageId === '' ? null : option.imageId,
          }))
        : [],
  };

  const latexPreview = renderLatex(latex);

  return (
    <form action={action} method="post" className="space-y-5">
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />

      <div className="grid gap-3 sm:grid-cols-3">
        <label className={labelClass}>
          Exam
          <select className={inputClass} name="examId" value={examId} onChange={(event) => setExamId(event.target.value)}>
            {catalog.exams.map((exam) => (
              <option key={exam.id} value={exam.id}>
                {exam.name}
              </option>
            ))}
          </select>
        </label>

        <label className={labelClass}>
          Subject
          <select
            className={inputClass}
            name="subjectId"
            value={subjectId}
            onChange={(event) => {
              setSubjectId(event.target.value);
              setTopicId('');
            }}
          >
            <option value="">Choose a subject</option>
            {subjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name}
              </option>
            ))}
          </select>
        </label>

        <label className={labelClass}>
          Topic (optional)
          <select className={inputClass} name="topicId" value={topicId} onChange={(event) => setTopicId(event.target.value)}>
            <option value="">No topic</option>
            {topics.map((topic) => (
              <option key={topic.id} value={topic.id}>
                {topic.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <label className={labelClass}>
          Type
          <select className={inputClass} value={questionType} onChange={(event) => setQuestionType(event.target.value)}>
            <option value="MCQ">MCQ</option>
            <option value="NUMERICAL">Numerical</option>
          </select>
        </label>
        <label className={labelClass}>
          Language
          <select className={inputClass} value={language} onChange={(event) => setLanguage(event.target.value)}>
            <option value="EN">English</option>
            <option value="HI">Hindi</option>
          </select>
        </label>
        <label className={labelClass}>
          Difficulty
          <select className={inputClass} value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
            <option value="EASY">Easy</option>
            <option value="MEDIUM">Medium</option>
            <option value="HARD">Hard</option>
          </select>
        </label>
        <label className={labelClass}>
          Marks / negative
          <span className="flex gap-2">
            <input className={inputClass} value={marks} onChange={(event) => setMarks(event.target.value)} inputMode="decimal" />
            <input
              className={inputClass}
              value={negativeMarks}
              onChange={(event) => setNegativeMarks(event.target.value)}
              inputMode="decimal"
            />
          </span>
        </label>
      </div>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <p className="mb-2 text-sm font-medium text-slate-200">Question text</p>
        <EditorContent editor={content} />
      </section>

      <label className={labelClass}>
        LaTeX (optional)
        <input
          className={inputClass}
          name="latex"
          value={latex}
          onChange={(event) => setLatex(event.target.value)}
          placeholder="\frac{1}{2} + \frac{1}{3}"
        />
      </label>

      {questionType === 'NUMERICAL' ? (
        <label className={labelClass}>
          Exact numerical answer
          <input
            className={inputClass}
            name="numericalAnswer"
            value={numericalAnswer}
            onChange={(event) => setNumericalAnswer(event.target.value)}
            inputMode="decimal"
          />
        </label>
      ) : (
        <section className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <p className="text-sm font-medium text-slate-200">Options (2 to 6, exactly one correct)</p>
          {options.map((option, index) => (
            <div key={String(index)} className="flex flex-wrap items-center gap-2">
              <span className="w-6 text-xs text-slate-500">{String.fromCharCode(65 + index)}</span>
              <input
                className={`${inputClass} flex-1`}
                value={option.optionHtml}
                placeholder="Option text"
                onChange={(event) =>
                  setOptions((current) =>
                    current.map((entry, position) =>
                      position === index ? { ...entry, optionHtml: event.target.value } : entry,
                    ),
                  )
                }
              />
              <label className="flex items-center gap-1 text-xs text-slate-400">
                <input
                  type="checkbox"
                  checked={option.isCorrect}
                  onChange={() =>
                    setOptions((current) =>
                      current.map((entry, position) => ({ ...entry, isCorrect: position === index })),
                    )
                  }
                />
                correct
              </label>
            </div>
          ))}
          <div className="flex gap-2">
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => setOptions((current) => [...current, { optionHtml: '', isCorrect: false, imageId: '' }])}
            >
              Add option
            </button>
            {options.length > 2 ? (
              <button type="button" className={secondaryButtonClass} onClick={() => setOptions((current) => current.slice(0, -1))}>
                Remove last
              </button>
            ) : null}
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <p className="mb-2 text-sm font-medium text-slate-200">Explanation (optional)</p>
        <EditorContent editor={explanation} />
      </section>

      <section data-testid="question-preview" className="rounded-2xl border border-sky-900/60 bg-sky-950/20 p-4">
        <p className="mb-2 text-xs uppercase tracking-wide text-sky-400">Student preview</p>
        <div className="space-y-2 text-sm text-slate-100" dangerouslySetInnerHTML={{ __html: payload.contentHtml }} />
        {latexPreview !== '' ? (
          <div className="text-slate-100" dangerouslySetInnerHTML={{ __html: latexPreview }} />
        ) : null}
        {questionType === 'MCQ' ? (
          <ol className="mt-3 space-y-1 text-sm text-slate-300">
            {options.map((option, index) => (
              <li key={String(index)}>
                {String.fromCharCode(65 + index)}. {option.optionHtml.replace(/<[^>]*>/g, ' ').trim()}
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <div className="flex flex-wrap gap-3">
        <button className={buttonClass} type="submit">
          {question === null ? 'Create draft' : 'Save draft'}
        </button>
        <a className={secondaryButtonClass} href={cancelHref}>
          Back to questions
        </a>
      </div>
    </form>
  );
}
