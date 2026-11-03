# Phase 4: what is done, and what it still owes

Phase 4 was merged to `main` as PR #16 (merge commit `0a677c5`). Everything under "done"
was proven by CI on the branch head `36af161`: 18 of 18 checks, nine jobs on both the push
and pull-request runs (jobs 125370547474–125370594520).

## Done and verified

| Piece | Proven by |
| --- | --- |
| Private S3-compatible object storage behind `OBJECT_STORAGE`; bucket private everywhere; dev credentials and public-bucket flags refused in production | `object-storage.spec.ts`, the production-boot test in `auth-http.test.ts`, decision 0038 |
| Upload pipeline: magic-byte type, size and pixel caps, sharp re-encode to WebP, EXIF stripped, SVG and unknown types refused, animated PNG/WebP refused by parsing the chunk list | `image.spec.ts` (bomb, truncated, polyglot, animated APNG/WebP, metadata-free output, chunk-list parsing) |
| Bounded decoding: 16 MP, two concurrent decodes, 10s timeout, a slot held until sharp settles, a capped queue answering 503 with `Retry-After` | `image.spec.ts`, `questions.test.ts` (HTTP 503 with the header) |
| Per-account upload meter: 30 uploads per ten minutes, own Redis key, 429 with `Retry-After` | `questions.test.ts` with a fresh editor, decision 0046 |
| Question model: `questions`, `question_versions`, `question_options`; published versions frozen by trigger; exactly one correct MCQ option; catalog alignment enforced | migration `20251001000000_questions`, `questions.test.ts` |
| Sanitiser: strict allowlist, media references by id only, output-side re-sanitising, fixed point, control/bidi/tag-character rules, a 38-payload XSS suite across question text, every option and the explanation | `sanitize.spec.ts` |
| Question API and editor UI: list with server-side search/filters/paging, draft and publish, CSV export audited, student preview | `questions.test.ts` (database) and the editor screens |
| Media ownership checked on sanitised HTML; an editor cannot point a question at somebody else's asset | `questions.test.ts` "refuses an image that belongs to another editor" |
| Option LaTeX: `latex` column, 4000-character check, same sanitiser and KaTeX options as the question's LaTeX | migration `20251201000000_question_option_latex`, `sanitize.spec.ts`, `questions.test.ts` |

## Phase 4b: owed, not skipped

| Item | Why it matters |
| --- | --- |
| Media-reference link table with `ON DELETE RESTRICT`, plus asset status and purpose checks in the ownership check | Today a referenced image could be deleted out from under a question |
| Media view route with a web proxy (uploader, admin, or an editor whose question uses it) and Playwright coverage | The browser has no authorised way to load a question image |
| TURN E: CSV import — worker job, staging tables, row-wise validation with the same sanitiser, all-or-nothing idempotent commit, CSV-injection-safe error reports | Bulk authoring is the point of the question bank |
| TURN F: ZIP import with `yauzl` — entry and size caps, traversal and symlink rejection, every image through the pipeline — plus Playwright for both import paths | Images referenced by file name |
| Phase 4 docs and claim table, and the final review report | Honest record |

## Known gaps carried forward

- `adobe/s3mock` accepts a presigned URL without validating signature or expiry; the
  launch-blocking integration test against the real production store is Phase 9.
- No page renders a signed image yet; `MEDIA_ORIGIN` is wired and tested but empty.
