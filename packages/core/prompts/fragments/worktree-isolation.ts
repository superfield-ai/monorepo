/**
 * Worktree isolation rules — agents must not touch anything outside their
 * assigned worktree, including other slots, the main checkout, or the system.
 */
export function worktreeIsolationFragment(worktreePath: string): string {
  return `\
## Worktree isolation

Your assigned worktree is:

\`${worktreePath}\`

All work must happen inside this directory. Do not:

- Touch files outside the worktree
- Touch the main repo checkout or any other issue's worktree
- Modify shared user config or system files
- Run commands that mutate state outside the worktree (e.g. \`gh repo edit\` \
on a different repo)

The first thing you do is \`cd\` into the worktree. Every subsequent shell \
command runs from there.`;
}
