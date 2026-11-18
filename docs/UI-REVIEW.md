# UI review from the screenshot gallery

Written from the data the gallery produces — `screenshots/report.json` in the `screenshots` artifact and
the job summary of the run that made it — and from nothing else. The gallery is `.github/workflows/screenshots.yml`,
its spec is `e2e/screenshots.spec.ts` and its fixture is `e2e/screenshots-fixture.ts`; run it by hand from
the Actions tab (it also runs when those files or this one change) and download `screenshots` from the
run's Artifacts section.

**What this review can and cannot say.** Every number below is measured by the spec in the running app:
the document title, images without `alt`, inputs without an associated label, `scrollWidth > clientWidth`
(horizontal overflow), the smallest interactive element on the page, and the console errors seen while the
page loaded. That is structure, not taste: it cannot say whether a screen looks good, whether the spacing
is right or whether the colours work. Those need eyes on the PNGs, and the PNGs are the point of the
artifact — open them. The person writing this could not open the images in the environment it ran in, so
nothing here describes what a screenshot looks like.

The screenshots contain fixture data only: accounts named `gallery-*-<random marker>@example.com`, an exam,
questions and papers created by the spec for that run. Nothing real is photographed. The repository is
public, so any signed-in GitHub user can download the artifact while it is retained (seven days).

## The run these numbers come from

- 68 screenshots at two viewports (phone 390×844, desktop 1280×800) from 34 screens; 2 skipped, both halves
  of one screen (below).
- The Playwright tour takes 44.9s; the job, with the stack boot and the browser install, 8m37s.
- The artifact is `screenshots`, about 3.6 MB, 69 files: the 68 PNGs plus `report.json`. The job summary
  carries the same table.

## What the numbers say

**Layout: no horizontal overflow anywhere.** All 68 captures report `scrollWidth <= clientWidth`. Nothing
broke sideways at 390px wide on any screen the tour reached. This is the one clean result in the review.

**Tap targets are small nearly everywhere.** On every screen measured, the smallest interactive element is
below the 44×44 guideline. The smallest on each screen, in source order:

| screens | smallest target |
| --- | --- |
| public/exams, admin/catalog | 44×14 — "/exams" and "Abhyas" breadcrumb links |
| public/login, register, forgot-password, verify-email, not-found (desktop) | 48×16 to 76×14 — text links in the header |
| student/account, catalog, wallet, test detail, instructions, taking, result, review; editor/denied | 35×20 — the "Tests" navigation link |
| editor/question-list | 37×20 — the "Open" link |
| admin/dashboard | 38×20 — the "Coins" navigation link |
| admin/tests | 50×20 — the "Review" link |
| admin/coins/user | 56×26 — the "Filter" button |
| admin/users | 58×30 — the "Open" link |
| editor and admin forms (question editor, test builder, user detail, settings, audit, coins) | 59×32 to 61×32 |
| editor/home | 103×16 — the "Open the tests" link |

The pattern is consistent: the small elements are inline links in navigation bars and breadcrumbs, and the
bigger ones (32px high) are the form controls. Nothing here is unusable on a phone, but nothing meets the
44×44 target either, and a thumb on a 14-high breadcrumb link is a miss waiting to happen.

**Two pages have no interactive element at all.** `01-public/home` (phone and desktop) and
`01-public/not-found` (phone) reported no visible `<a href>`, `<button>` or `role="button"`. For the home
page that is not a measurement artefact: `apps/web/src/app/page.tsx` renders the API health panel and
nothing else — no link to the catalogue, to sign in or to register. A visitor who lands there has nowhere
to go.

**Four inputs on the editor's question list have no label.** `04-editor/question-list` reports 4 unlabelled
fields at both viewports, and `04-editor/question-editor` reports 3. The rest of the forms — sign in,
register, the test builder, the admin screens — report 0. Unlabelled inputs are a screen-reader problem and,
for a search/filter box, also a usability one.

**Images: none missing `alt`.** Every capture reports 0 images without `alt`. Most of these screens carry no
`<img>` at all, so this says the few that do are labelled, not that image coverage is complete.

**Console errors cluster on the Turnstile widget.** No screen logged a JavaScript exception. The errors are
network-level and repeated: `Failed to load resource: the server responded with a status of 400` followed by
`[Cloudflare Turnstile] Error: 400020` on `public/login` (desktop), `public/register` (phone),
`public/forgot-password` (phone), `account/verify-email-sent` (phone), `student/account` (phone),
`editor/home` (phone, twice) and `admin/dashboard` (phone, twice). `400020` is Turnstile's "invalid sitekey"
answer; the stack runs Cloudflare's always-pass test key, and the specs pre-fill the test token, so the form
still submits. The noise is real, though: a genuine error on any of those pages would be hard to spot among
it, and the phone viewport sees it far more often than the desktop one.

**Page titles do not distinguish screens.** Every capture reports `title=Abhyas` except `public/exams`,
which reports `Exams | Abhyas`. The catalogue pages of Phase 4 are the only ones with their own `<title>`;
the rest of the app, signed in or not, shares one. That is a bookmark and browser-tab problem more than a
visual one, but it is the same kind of omission as the missing nav on the home page.

## Skipped

`03-student/attempt-unavailable` (phone and desktop) timed out waiting for its marker, 15s each. The screen
is the one a student sees when an attempt id is not theirs or no longer exists; the tour could not produce
that state from a fixture that has an open enrollment, so there is no picture of it. Everything else in the
list rendered.

## Inconsistencies the structure shows

- **Navigation shape differs by role.** Students see a "Tests" link first (35×20); editors see "Open the
  tests" (103×16) and "Tests"; administrators see "Coins" (38×20) and "Tests". The same idea is a different
  word and a different size in three places.
- **Form controls are consistently ~32px high** across editor and admin forms, which is at least uniform,
  but both are below the 44px target.
- **The public header's links are the smallest things on the public pages** (14–16px high), which is where a
  first-time visitor's taps land.

## What still needs a person

Open the 68 PNGs. Nothing above replaces looking at them: the review can say that no phone layout overflows,
that the tap targets are small and that the home page has no way out — it cannot say whether the result page
reads well, whether the review page's filters are where a student would look for them, or whether the admin
screens feel like one product. That judgement is the owner's, and the artifact is there for it.


## After F1

The numbers come from the gallery run on the F1 branch (`fe/f1-structure`, head `8c435bf`), the same run whose
`GALLERY-A11Y` line reads: captures=70, unlabeled inputs=0, images without alt=0, overflow=0, phone screens
under 44×44=24.

| Count | Before (main) | After F1 |
| --- | --- | --- |
| Screenshots captured | 68 of 70 | **70 of 70** |
| Screens skipped | 2 (`attempt-unavailable`, both viewports — wrong test id) | **0** |
| Inputs without a label | 4 (question list) + 3 (question editor) | **0** |
| Images without `alt` | 0 | 0 |
| Horizontal overflow | 0 | 0 |
| Home page interactive elements | none | Sign in (87×44), Register, Browse the exams |
| Student "Tests" link on a phone | 35×20 on 18 screens | **51×44**; one shared `StudentNav` |
| `/exams` breadcrumb on a phone | 44×14 | **52×44** |
| Phone screens still under 44×44 | 27 | **24** |

**What is still under 44×44 on the phone**, from the run's log: the public auth pages' small "Abhyas" and
"Sign in" links (76×14, 48×16); `03-student/catalog`'s "View" (59×30) and `03-student/wallet`'s "Filter"
(56×26); the review page's filter chips (43×44 — 1px short in width); and the editor and admin navigation
rows, whose links are 37×20 to 59×32 (`04-editor/*`, `05-admin/*`), plus `05-admin/catalog`'s `/exams`
(44×14). Those live in `AdminNav` and in the auth shell, which F1 did not change — they are the next unit,
not a regression.

The Turnstile `400020` console errors remain on the auth pages, as expected with the always-pass test key
(`docs/deployment.md`, "Turnstile keys"). No new console errors appeared.




## After F2

The numbers come from the gallery run on `fe/f2-targets-focus` (head `a82c550`). Its log prints, verbatim:

```
GALLERY-SUMMARY 70 shots, 0 skipped
GALLERY-A11Y    captures=70, unlabeled inputs=0, images without alt=0, overflow=0, phone screens under 44x44=4
GALLERY-A11Y2   phone: controls without a focus style=26 of 407,
                error fields without aria-describedby=0 of 6;
                pages: not exactly one h1=2, not exactly one main=2
```

The stand-alone-under-44 count is 23 across the 35 phone screens, summed from the per-screen
`GALLERY` lines (the same lines that name the controls); those per-screen lines are the list.

| Count | Before (main) | After F1 | After F2 |
| --- | --- | --- | --- |
| Screenshots captured | 68 of 70 | 70 of 70 | **70 of 70** |
| Screens skipped | 2 | 0 | **0** |
| Inputs without a label | 7 | 0 | **0** |
| Images without `alt` | 0 | 0 | **0** |
| Horizontal overflow | 0 | 0 | **0** |
| Phone screens whose smallest target is under 44×44 | 27 | 24 | **4** |
| Stand-alone controls under 44×44 on the phone | not measured | not measured | **23, on 9 of 35 screens** |
| Controls with no visible focus style | not measured | not measured | **26 of 407** (all on `05-admin/catalog`) |
| Error fields without `aria-describedby` | not measured | not measured | **0 of 6** |
| Pages without exactly one `h1` / one `main` | not measured | not measured | **2 / 2** (the 404 screen only) |

**What still fails, and why.** All 23 remaining stand-alone targets are in two places:

- **The surfaces that were not part of this unit.** `03-student/account` (and the same page when an
  editor is refused) 1, `05-admin/users` 5, `05-admin/user-detail` 1, `05-admin/catalog` 4, the
  editor question list 2, the question editor 6, and the test builder 1 on each of its two states.
  These are the row buttons and the secondary form controls of screens whose actions are mostly
  `<button>`s inside forms rather than links; several are 38px high (the `px-3 py-2` form buttons).
- **Three single links.** `03-student/attempt-unavailable`'s "Back to your tests" (127×20), and the
  test builder's "Back to the list" (105×20) on both its states — the only below-44 elements on
  those screens, and both are the sort of link the next pass should give the shared class.

The two inline exemptions are the two paragraph links on `04-editor/home` ("Open the catalog" and
"Open the tests"), which are prose and stay prose by this unit's own rule.

**Focus:** 381 of the 407 controls the phone screens measured changed their computed outline or
box-shadow when focused with `focus({ focusVisible: true })`. The 26 that did not are all on
`05-admin/catalog`, and the same 26 of 43 appear on its desktop capture: the catalog tree's own
controls, which the walk could not make focusable. That is the one number this review cannot yet
call fixed, and it needs a look at the catalog tree's controls by hand.

**Landmarks and headings:** every screen has exactly one `h1` except the two captures of the 404
screen, which Next renders with its own `h1` and no `<main>`. Every other page has exactly one
`<main id="main">`, and the root layout now opens with a "Skip to main content" link that targets it.

**Form errors:** the gallery reaches the auth forms' error state through their `?error=` URLs (no
new picture — the same 70 captures) and finds `role="alert"` on the message and `aria-invalid` +
`aria-describedby` on the six fields that produce it. The reset-password and the mobile OTP forms
carry the same wiring but the tour could not reach them without a real token or an OTP stack, so
they are not counted here.

**The e2e run on this head is red, and not for a UI reason.** `e2e/otp-enabled.spec.ts:107` expects
`/account?mobile=linked` after submitting the add-a-number confirmation and receives
`/account?sent=1&destination=%2B919697033080&resend=60`; it failed on the retry too. Nothing in this
unit's diff touches the account page's forms, the OTP routes or the API — the account page gained a
`main` id, an import and a link class. It is recorded here rather than hidden: until it is green the
branch is not mergeable, and the next session starts with that test.
