-- Phase 4: LaTeX on an option, with the same limit the question's own LaTeX has.
--
-- An option is prose plus an optional formula, exactly like the question text: the number
-- is drawn by KaTeX in the browser and the text is what the student reads beside it.
-- 4000 characters matches `MAX_LATEX_LENGTH` in the sanitiser.

ALTER TABLE "question_options" ADD COLUMN "latex" TEXT;

ALTER TABLE "question_options"
    ADD CONSTRAINT "question_options_latex_length"
    CHECK ("latex" IS NULL OR char_length("latex") <= 4000);
