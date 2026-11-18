/**
 * The phone tap target, in one place.
 *
 * 44×44 CSS pixels is the size a thumb hits reliably: WCAG 2.2 asks for 24×24, this project's
 * own UI review and Apple's guidance ask for 44. The `sm:` overrides reset both dimensions above
 * the phone breakpoint, so the desktop rows keep the compact look they were designed with — the
 * size a page already had only changes where a finger is doing the aiming.
 *
 * It is a class string rather than a component so a Link, a button or a form control can all wear
 * it, and so the shells that share it stay the only place the rule is written.
 */
export const tapTargetClass =
  'inline-flex min-h-11 min-w-11 items-center justify-center sm:min-h-0 sm:min-w-0';
