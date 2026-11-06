import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * A published exam, one subject and two published questions, owned by the editor whose id is
 * passed in.
 *
 * The builder spec is about the test screens, not about assembling a question bank through
 * the TipTap editor, so the bank is seeded directly in the e2e stack's database — the same
 * `docker compose exec` route `./coin-settings` uses. Both rows are owned by the editor
 * because the API only lets an editor place their own questions on their own paper, and the
 * question versions are written unpublished, then published, because `question_options_frozen`
 * refuses options inserted into a version whose `published_at` is already set.
 */

export interface BuilderFixture {
  readonly examId: string;
  readonly alphaQuestionId: string;
  readonly betaQuestionId: string;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function seedBuilderFixture(input: {
  readonly editorId: string;
  readonly marker: string;
  readonly alphaText: string;
  readonly betaText: string;
}): BuilderFixture {
  const category = randomUUID();
  const exam = randomUUID();
  const subject = randomUUID();
  const alpha = randomUUID();
  const beta = randomUUID();

  const sql = [
    'DO $$',
    'BEGIN',
    `  INSERT INTO exam_categories (id, name, slug, created_by) VALUES (${sqlLiteral(category)}::uuid, ${sqlLiteral(`E2E Builder Category ${input.marker}`)}, ${sqlLiteral(`e2e-builder-cat-${input.marker}`)}, ${sqlLiteral(input.editorId)}::uuid);`,
    `  INSERT INTO exams (id, category_id, name, slug, created_by) VALUES (${sqlLiteral(exam)}::uuid, ${sqlLiteral(category)}::uuid, ${sqlLiteral(`E2E Builder Exam ${input.marker}`)}, ${sqlLiteral(`e2e-builder-exam-${input.marker}`)}, ${sqlLiteral(input.editorId)}::uuid);`,
    `  INSERT INTO subjects (id, exam_id, name, slug, created_by) VALUES (${sqlLiteral(subject)}::uuid, ${sqlLiteral(exam)}::uuid, 'Reasoning', ${sqlLiteral(`e2e-builder-sub-${input.marker}`)}, ${sqlLiteral(input.editorId)}::uuid);`,
    `  INSERT INTO questions (id, exam_id, subject_id, created_by, status, current_version) VALUES (${sqlLiteral(alpha)}::uuid, ${sqlLiteral(exam)}::uuid, ${sqlLiteral(subject)}::uuid, ${sqlLiteral(input.editorId)}::uuid, 'PUBLISHED', 1);`,
    `  INSERT INTO questions (id, exam_id, subject_id, created_by, status, current_version) VALUES (${sqlLiteral(beta)}::uuid, ${sqlLiteral(exam)}::uuid, ${sqlLiteral(subject)}::uuid, ${sqlLiteral(input.editorId)}::uuid, 'PUBLISHED', 1);`,
    `  INSERT INTO question_versions (question_id, version, question_type, language, difficulty, content_html, explanation_html, marks, negative_marks, created_by) VALUES (${sqlLiteral(alpha)}::uuid, 1, 'MCQ', 'EN', 'MEDIUM', ${sqlLiteral(`<p>${input.alphaText}</p>`)}, '<p>Alpha has no divisors.</p>', 2, 0.5, ${sqlLiteral(input.editorId)}::uuid);`,
    `  INSERT INTO question_versions (question_id, version, question_type, language, difficulty, content_html, explanation_html, marks, negative_marks, created_by) VALUES (${sqlLiteral(beta)}::uuid, 1, 'MCQ', 'EN', 'MEDIUM', ${sqlLiteral(`<p>${input.betaText}</p>`)}, '<p>Beta is even.</p>', 2, 0.5, ${sqlLiteral(input.editorId)}::uuid);`,
    `  INSERT INTO question_options (question_version_id, position, option_html, is_correct) SELECT id, 1, '<p>4</p>', false FROM question_versions WHERE question_id = ${sqlLiteral(alpha)}::uuid;`,
    `  INSERT INTO question_options (question_version_id, position, option_html, is_correct) SELECT id, 2, '<p>7</p>', true FROM question_versions WHERE question_id = ${sqlLiteral(alpha)}::uuid;`,
    `  INSERT INTO question_options (question_version_id, position, option_html, is_correct) SELECT id, 3, '<p>9</p>', false FROM question_versions WHERE question_id = ${sqlLiteral(alpha)}::uuid;`,
    `  INSERT INTO question_options (question_version_id, position, option_html, is_correct) SELECT id, 1, '<p>2</p>', false FROM question_versions WHERE question_id = ${sqlLiteral(beta)}::uuid;`,
    `  INSERT INTO question_options (question_version_id, position, option_html, is_correct) SELECT id, 2, '<p>6</p>', true FROM question_versions WHERE question_id = ${sqlLiteral(beta)}::uuid;`,
    `  INSERT INTO question_options (question_version_id, position, option_html, is_correct) SELECT id, 3, '<p>7</p>', false FROM question_versions WHERE question_id = ${sqlLiteral(beta)}::uuid;`,
    `  UPDATE question_versions SET published_at = now() WHERE question_id IN (${sqlLiteral(alpha)}::uuid, ${sqlLiteral(beta)}::uuid);`,
    'END $$;',
  ].join('\n');

  execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'abhyas', '-d', 'abhyas', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { cwd: process.cwd(), encoding: 'utf8' },
  );

  return { examId: exam, alphaQuestionId: alpha, betaQuestionId: beta };
}
