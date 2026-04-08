export { projectContextFragment } from "./project-context.ts";
export { commitStandardsFragment } from "./commit-standards.ts";
export { worktreeIsolationFragment } from "./worktree-isolation.ts";
export { roleFragment } from "./role.ts";
export { tddOutsideInFragment } from "./tdd-outside-in.ts";
export { blueprintReferenceFragment } from "./blueprint-reference.ts";

/** Joins prompt sections with a blank line between each. */
export function joinSections(
  ...sections: (string | null | undefined)[]
): string {
  return sections
    .filter((s): s is string => Boolean(s && s.trim()))
    .join("\n\n");
}

/** Renders an array of strings as a markdown bullet list. */
export function bullet(items: string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}

/** Renders an array of strings as a numbered markdown list. */
export function numbered(items: string[]): string {
  return items.map((i, n) => `${n + 1}. ${i}`).join("\n");
}
