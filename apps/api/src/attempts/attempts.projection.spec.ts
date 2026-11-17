import { describe, expect, it } from 'vitest';

import { paperQuestion, reviewQuestion } from './attempts.projection';

/**
 * The start response's projection is an allowlist, not a redaction: these tests hand it rows
 * that carry the answer key, the numerical answer and the explanation as extra properties, and
 * assert they cannot come out.
 */

const version = {
  questionType: 'MCQ',
  contentHtml: '<p>Which is prime?</p>',
  latex: null,
  marks: { toString: () => '2' },
  negativeMarks: { toString: () => '0.5' },
  // Extra properties a real row carries and the projection must never copy.
  numericalAnswer: null,
  explanationHtml: '<p>Seven.</p>',
  isCorrect: true,
  createdBy: 'secret-creator',
  status: 'PUBLISHED',
};

const options = [
  { id: 'o1', position: 1, optionHtml: '<p>4</p>', latex: null, isCorrect: false, imageId: null },
  { id: 'o2', position: 2, optionHtml: '<p>7</p>', latex: 'x^2', isCorrect: true, imageId: null },
];

describe('the paper projection', () => {
  it('carries exactly the answerable fields', () => {
    const view = paperQuestion(1, 'q1', version, options);

    expect(Object.keys(view).sort()).toEqual(
      ['contentHtml', 'latex', 'marks', 'negativeMarks', 'options', 'position', 'questionId', 'questionType'].sort(),
    );
    expect(view.options).toHaveLength(2);
    for (const option of view.options) {
      expect(Object.keys(option).sort()).toEqual(['id', 'latex', 'optionHtml', 'position'].sort());
    }
  });

  it('never carries the answer key, a numerical answer or an explanation', () => {
    const serialised = JSON.stringify(paperQuestion(1, 'q1', version, options));

    expect(serialised).not.toContain('isCorrect');
    expect(serialised).not.toContain('numericalAnswer');
    expect(serialised).not.toContain('explanation');
    expect(serialised).not.toContain('secret-creator');
    expect(serialised).not.toContain('PUBLISHED');
  });

  it('sanitises the stem and the options', () => {
    const view = paperQuestion(
      2,
      'q2',
      { ...version, contentHtml: '<p>Hi</p><script>alert(1)</script>' },
      [{ id: 'o1', position: 1, optionHtml: '<p>Safe</p><script>bad()</script>', latex: null }],
    );

    expect(view.contentHtml).not.toContain('<script>');
    expect(view.options[0]?.optionHtml).not.toContain('<script>');
  });

  it('is the only shape that adds the key and the explanation', () => {
    const review = reviewQuestion(1, 'q1', version, options, (id) => id === 'o1');

    expect(review.explanationHtml).toContain('Seven');
    expect(review.chosenOptionId).toBe('o1');
    expect(review.correctOptionId).toBe('o2');
    expect(review.options.find((option) => option.id === 'o2')).toMatchObject({ isCorrect: true, isChosen: false });
  });
});
