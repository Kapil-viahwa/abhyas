/**
 * The two capabilities an Administrator can give an editor, and the permission codes they
 * map to.
 *
 * A flag is not a stored column: it is a row in `user_permissions`. An editor with no row for
 * a flag does not hold that capability at all, which is why an omitted flag is a denial
 * rather than a default. The database enforces both halves of that rule (see migration
 * 20250601000000_user_management, tightened by 20270101000000_tests_and_enrollments).
 *
 * Publishing a test is not a flag: `tests.publish` belongs to an Administrator alone
 * (decision 0069). Publishing a question is a content action and travels with the role, as
 * `content.publish`.
 */
export const EDITOR_FLAG_PERMISSIONS = {
  manage_questions: 'content.write',
  manage_tests: 'tests.write',
} as const;

export type EditorFlag = keyof typeof EDITOR_FLAG_PERMISSIONS;

export type EditorFlags = Record<EditorFlag, boolean>;

export const EDITOR_FLAGS: readonly EditorFlag[] = ['manage_questions', 'manage_tests'];

/** The permission codes editor flags are allowed to touch, in one place. */
export const EDITOR_FLAG_CODES: readonly string[] = Object.values(EDITOR_FLAG_PERMISSIONS);

export const EMPTY_EDITOR_FLAGS: EditorFlags = {
  manage_questions: false,
  manage_tests: false,
};

/** Which flags a set of granted permission codes represents. */
export function flagsFromCodes(codes: Iterable<string>): EditorFlags {
  const granted = new Set(codes);
  const flags: EditorFlags = { ...EMPTY_EDITOR_FLAGS };

  for (const flag of EDITOR_FLAGS) {
    flags[flag] = granted.has(EDITOR_FLAG_PERMISSIONS[flag]);
  }

  return flags;
}

/** The permission codes a set of ticked flags needs. An unticked flag contributes none. */
export function codesForFlags(flags: Partial<EditorFlags>): string[] {
  return EDITOR_FLAGS.filter((flag) => flags[flag] === true).map(
    (flag) => EDITOR_FLAG_PERMISSIONS[flag],
  );
}

export function isEditorFlag(value: string): value is EditorFlag {
  return (EDITOR_FLAGS as readonly string[]).includes(value);
}
