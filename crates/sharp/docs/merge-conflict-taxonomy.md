# Git Merge Conflict Taxonomy

**Purpose:** This document is the primary reference for expanding the Sharp test corpus. Every category maps directly to one or more fixture directories under `tests/scenarios/`. Authors adding new scenarios should find a home here first, confirm whether the category is already covered, and follow the design notes to reproduce the failure mode.

**Taxonomy axes:**

| Class                      | Git behaviour                        | Human needed?                                                   |
| -------------------------- | ------------------------------------ | --------------------------------------------------------------- |
| **A. False negative**      | Reports CONFLICT when it shouldn't   | No — both changes are independent                               |
| **B. False positive**      | Reports clean merge; output is wrong | No — one semantic resolution is obvious, but git picked neither |
| **C. Legitimate conflict** | Reports CONFLICT correctly           | Yes — human (or oracle) must decide                             |
| **D. Cross-cutting**       | Edge cases that span the above axes  | Depends                                                         |

**Coverage key used throughout:**

- `COVERED` — at least one scenario in `tests/scenarios/` exercises this failure mode.
- `PARTIAL` — covered in one language but not the other, or only a sub-variant.
- `MISSING` — no scenario exists; a new fixture is needed.

---

## Section A: False Negatives — Git Flags CONFLICT When It Should Auto-Resolve

Git's three-way merge algorithm works at the line (hunk) level. It calls a region "conflicting" whenever the same lines were touched in both branches, even when the actual edits are logically independent and the correct merged result is unambiguous. Each item in this section is a case where a smarter merge strategy — AST-aware, import-aware, whitespace-aware, or context-aware — can produce the correct output without human involvement.

---

### A1. Adjacent-Line Insertion (Hunk Adjacency)

**Description:** Both branches insert one or more new lines immediately after the same anchor line. Git's diff hunk computation collapses both insertions into a single conflict region because they share a context boundary, even though the two insertions are completely independent.

This is perhaps the most common false conflict seen in practice. It affects any file section where multiple developers independently add items: config objects, feature-flag maps, struct fields, enum variants, test cases, route tables, export lists.

**Mechanism:** Git's diff3 algorithm uses a fixed context window (typically three lines). When two branches both insert after the same line, the overlap in context causes the algorithm to mark the entire insertion region as conflicting.

**Minimal TypeScript example:**

```typescript
// base
const config = {
  host: 'localhost',
};

// branch_a adds:
const config = {
  host: 'localhost',
  port: 5432, // <-- A's addition
};

// branch_b adds:
const config = {
  host: 'localhost',
  timeout: 30, // <-- B's addition
};

// git produces CONFLICT; correct merge is:
const config = {
  host: 'localhost',
  port: 5432,
  timeout: 30,
};
```

**Minimal Rust example:**

```rust
// base
struct Config {
    host: String,
}

// branch_a
struct Config {
    host: String,
    port: u16,     // A's addition
}

// branch_b
struct Config {
    host: String,
    timeout: u32,  // B's addition
}
// correct: include both fields
```

**Sharp coverage:** `COVERED`

- `reorder/ts/parallel_object_property_additions` — TS config object
- `reorder/ts/parallel_export_additions` — TS function exports
- `reorder/rust/parallel_struct_field_additions` — Rust struct fields
- `reorder/rust/parallel_impl_additions` — Rust impl block methods

**Recommended fixture category:** `reorder`

**Design note:** The correct resolution is always to concatenate both additions; order may be arbitrary (both orderings are valid). The verification gate (tsc/cargo check) confirms neither order breaks compilation.

---

### A2. Parallel Function/Method Additions to Same File Region

**Description:** Both branches add entirely new, independent functions or methods to the same region of a file (bottom of file, bottom of an impl block, end of a class body). Git cannot tell the two additions apart from a simultaneous edit of the same lines, so it flags a conflict.

**Differs from A1:** The insertion unit is a multi-line function definition rather than a single property line, but the root cause is identical: shared anchor line context.

**Minimal TypeScript example:**

```typescript
// base: utils.ts (empty or with one function)
export function add(a: number, b: number): number {
  return a + b;
}

// branch_a appends:
export function multiply(a: number, b: number): number {
  return a * b;
}

// branch_b appends:
export function subtract(a: number, b: number): number {
  return a - b;
}

// git CONFLICT; correct: both functions included
```

**Sharp coverage:** `COVERED` (via `reorder/ts/parallel_export_additions`)
**Missing variant:** Multi-line function bodies with Rust impl methods is `COVERED` via `reorder/rust/parallel_impl_additions`.

**Recommended fixture category:** `reorder`

---

### A3. Parallel Import / Use Statement Additions

**Description:** Both branches add independent import statements (TypeScript `import { X } from '...'` or Rust `use crate::X`) to the import section of a file. Because both insertions target the same anchor line (the last existing import), git produces a conflict.

**Distinct sub-variants:**

- **A3a. Pure import addition** — no body changes; only the import list differs.
- **A3b. Import addition bundled with body change** — both branches add an import _and_ make changes elsewhere in the file. The import conflict and the body conflict may or may not be independent.

**Minimal TypeScript example (A3a):**

```typescript
// base
import { existsSync } from 'node:fs';

// branch_a
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs'; // new

// branch_b
import { existsSync } from 'node:fs';
import { resolve } from 'node:path'; // new

// git CONFLICT; correct: both new imports included
```

**Sharp coverage:**

- A3a: `COVERED` via `import_merge/ts/parallel_import_only`
- A3b: `PARTIAL` — `import_merge/ts/parallel_imports` covers the bundled case but is classified as `dilemma` because the body changes are incompatible, not because of the imports.
- Rust: `COVERED` via `import_merge/rust/parallel_use_lines`

**Recommended fixture category:** `import_merge`

**Design note:** A3a is a clean false negative; A3b may be a mix of false negative (imports) and legitimate conflict (body). Sharp should be able to resolve the import portion independently and escalate only the body portion.

---

### A4. Parallel Struct/Object/Enum Property Additions

**Description:** A specific instance of A1, but the insertion unit is a named property in a structured container: a TypeScript object literal, a TypeScript interface field, a Rust struct field, a Rust enum variant, a JSON/YAML map entry. The conflict is false because the two new properties are independent.

**Why it deserves its own entry:** Struct/object additions are order-insensitive in most languages (struct fields, interface fields, object properties, enum variants have no required ordering). An AST-aware merger can verify independence by checking that neither branch's addition references the other's addition by name.

**Minimal Rust example (enum variant addition):**

```rust
// base
enum Status {
    Active,
    Inactive,
}

// branch_a adds:
enum Status {
    Active,
    Inactive,
    Pending,   // A's new variant
}

// branch_b adds:
enum Status {
    Active,
    Inactive,
    Archived,  // B's new variant
}

// git CONFLICT; correct: both variants included
```

**Sharp coverage:** `PARTIAL`

- TS object literal: `COVERED` (`reorder/ts/parallel_object_property_additions`)
- Rust struct field: `COVERED` (`reorder/rust/parallel_struct_field_additions`)
- Rust enum variant: `MISSING` — no fixture for parallel enum variant additions
- TypeScript interface field additions: `MISSING`
- TypeScript enum additions: `MISSING`

**Recommended fixture category:** `reorder`

---

### A5. Whitespace-Only Reformat vs. Semantic Edit on Different Lines

**Description:** Branch A reformats a file or block (changes indentation, wraps long lines, normalises spacing) without changing any semantics. Branch B edits a value or expression inside the same region. Git's line-level diff sees every reformatted line as "changed" by A, and B's edit as "changed" by B, so it marks the entire region as conflicting even though the actual semantic change (B's edit) can be applied cleanly to A's reformatted output.

**Why it is a false negative:** The changes are independent at the semantic level. A's change is meaning-preserving (pure reformatting), and B's change is a targeted semantic edit that does not depend on the old indentation.

**Minimal TypeScript example:**

```typescript
// base
function process(x: number) {
  if (x > 0) {
    return x * 2;
  }
  return 0;
}

// branch_a (reformat):
function process(x: number) {
  if (x > 0) {
    return x * 2;
  }
  return 0;
}

// branch_b (semantic edit on same region):
function process(x: number) {
  if (x > 0) {
    return x * 3;
  } // changed 2 -> 3
  return 0;
}

// git CONFLICT; correct merge applies B's 3 into A's formatted version
```

**Sharp coverage:** `COVERED`

- `format/ts/format_then_edit`
- `format/rust/format_then_edit`

**Recommended fixture category:** `format`

**Missing variants:**

- Multi-file reformat (formatter runs across a whole directory) + single-file semantic edit: `MISSING`
- Reformat that changes line count (e.g., wrapping) vs. insertion inside: `MISSING`

---

### A6. Reindentation of a Block vs. Edit Inside It

**Description:** A close relative of A5, but specifically focused on indentation changes caused by structural refactoring: wrapping code in a new `if`, pulling code into a new function, unindenting after removing a layer of nesting. Branch B independently edits a value inside the same block. The two changes do not conflict at the semantic level.

**Minimal TypeScript example:**

```typescript
// base
function handle(req: Request) {
  const data = parse(req.body);
  log(data);
  return data;
}

// branch_a: wraps body in a null check (adds one level of indentation):
function handle(req: Request) {
  if (req.body) {
    const data = parse(req.body);
    log(data);
    return data;
  }
}

// branch_b: changes log() call to logDebug():
function handle(req: Request) {
  const data = parse(req.body);
  logDebug(data); // changed
  return data;
}

// git CONFLICT; correct: apply B's logDebug change inside A's null check
```

**Sharp coverage:** `MISSING` — the existing `format/` scenarios cover pure whitespace changes, not structural reindentation caused by wrapping. A dedicated scenario for wrap-then-edit is needed.

**Recommended fixture category:** `format`

---

### A7. Comment-Only Change vs. Nearby Semantic Edit

**Description:** Branch A adds, removes, or rewrites a comment adjacent to a function or variable. Branch B makes a semantic edit (value change, type annotation, refactoring) on nearby lines. Git's hunk algorithm may group both changes into one conflicting region because comments and code share line context.

**Minimal TypeScript example:**

```typescript
// base
// Returns the total price
function totalPrice(items: Item[]): number {
  return items.reduce((s, i) => s + i.price, 0);
}

// branch_a updates the comment:
// Returns the total price including tax
function totalPrice(items: Item[]): number {
  return items.reduce((s, i) => s + i.price, 0);
}

// branch_b changes the body:
// Returns the total price
function totalPrice(items: Item[]): number {
  return items.reduce((s, i) => s + i.price * i.qty, 0); // adds qty
}

// git may CONFLICT; correct: A's comment + B's body change
```

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `format` (comment changes are semantically inert and should be treated like whitespace for resolution purposes)

---

### A8. Line Ending Normalization Conflicts (CRLF vs. LF)

**Description:** One branch normalises line endings (e.g., CRLF to LF) across a file; the other branch makes a semantic edit to the same file. Git sees both branches as modifying every line that had CRLF, causing the entire file to conflict even though the semantic change is isolated to one location.

**Mechanism:** Git's `core.autocrlf` and `.gitattributes` settings control line ending normalisation, but when a branch explicitly changes line endings in the committed object, git's three-way diff sees every line as modified.

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `format` (line ending normalisation is a form of whitespace-only change; the correct resolution applies the semantic edit to the normalised file)

**Design note:** This scenario is platform-dependent. Fixtures should commit files with explicit CRLF bytes rather than relying on git config. Use `.gitattributes: * -text` to prevent git from normalising during the test.

---

### A9. Trailing Newline Addition vs. Semantic Edit

**Description:** Branch A adds a missing trailing newline to a file (a common linter fix). Branch B edits the last line of the same file. Git may see both as modifying the end of file and flag a conflict.

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `format`

---

### A10. Both Branches Delete the Same Code Identically

**Description:** Both branches independently delete the same lines (e.g., remove a dead function, delete a deprecated constant). The deletions are identical: the result is unambiguous (the code is gone), but git may still flag a conflict if the surrounding context differs slightly between branches.

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `reorder` or `format`

**Note:** git's `ort` strategy (default since Git 2.34) handles identical-both-sides deletions better than the older `recursive` strategy. However, if the surrounding context has also been modified by one branch, git can still produce unnecessary conflicts.

---

### A11. File Mode Change vs. Content Edit

**Description:** One branch changes a file's mode (e.g., makes a script executable: `chmod +x`). The other branch edits the file's content. Git reports this as a mode conflict combined with a content conflict, though both changes are independent and both should be applied.

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `format` or a new `mode_change` category

---

### A12. Submodule Pointer vs. Unrelated File Edit

**Description:** One branch bumps a submodule to a new commit. The other branch edits a file in the parent repository that is unrelated to the submodule. Git can sometimes flag a conflict in the `.gitmodules` file or the submodule ref if both branches touched submodule-related metadata.

**Sharp coverage:** `MISSING` (submodules are out of scope for Sharp v1 but relevant to document)

---

## Section B: False Positives — Git Produces Clean Merge That Is Semantically Wrong

These are the most dangerous failure modes: git reports a successful merge with no conflict markers, but the resulting tree does not compile, does not type-check, or has silently wrong runtime behaviour. A human reviewing the merge would not see any markers to investigate. Only a post-merge build or test run catches the problem.

All items in this section are `expected_git_outcome: clean_wrong` in Sharp fixture terms.

---

### B1. Cross-File Symbol Rename: Rename in Existing Files, Stale Name in New Caller

**Description:** Branch A renames a symbol (function, class, type, constant) and updates all _existing_ callers. Branch B adds a brand new file that uses the _old_ name. Because git's rename detection operates at the file level, not the symbol level, the text merge succeeds: A's renamed symbol lands correctly in existing files, and B's new file references a name that no longer exists.

**Why it is a false positive:** No lines overlap between branches. A modified existing files; B added a new file. The three-way merge has nothing to conflict on. The breakage is entirely semantic: the symbol B refers to was renamed by A.

**Minimal TypeScript example:**

```typescript
// base: lib.ts
export function computeTotal(items: Item[]): number { ... }

// branch_a: renames computeTotal -> computeOrderTotal in lib.ts and all callers
// branch_b: adds report.ts that calls computeTotal()  (the old name)

// merged tree: computeTotal is gone; report.ts calls computeTotal() -> tsc error
```

**Sharp coverage:** `COVERED`

- `refactor/ts/rename_function_with_callsite_edit`
- `refactor/ts/export_rename_with_import_update`
- `cross_file_rename/ts/symbol_renamed_one_branch_used_in_other`
- `cross_file_rename/rust/struct_renamed_one_branch_used_in_other`

**Recommended fixture category:** `cross_file_rename` or `refactor`

---

### B2. Function Signature Change + New Caller with Old Signature

**Description:** Branch A changes a function's signature (adds a required parameter, changes a parameter type, changes the return type) and updates all _existing_ call sites. Branch B adds a new file that calls the function with the _old_ signature. Text merge succeeds; the new caller is broken.

**Minimal TypeScript example:**

```typescript
// base: math.ts
export function sum(a: number, b: number): number {
  return a + b;
}

// branch_a: adds third required parameter `c`; updates all existing callers
// branch_b: adds calculator.ts that calls sum(x, y)  (old two-arg form)

// merged: sum() now requires three args; calculator.ts passes two -> tsc error
```

**Variants:**

- **B2a. Arity increase** — new required parameter added (shown above)
- **B2b. Parameter type narrowing** — parameter type changed from `string` to `number`; new caller passes a string
- **B2c. Return type change** — function return type changed; new caller treats result as old type
- **B2d. Parameter made optional to required** — branch A makes an optional param required; branch B's new file omits it

**Sharp coverage:** `COVERED` (B2a via `refactor/ts/signature_change_with_caller_update`)
Missing:

- B2b parameter type narrowing: `MISSING`
- B2c return type change: `MISSING`
- Rust equivalent (trait method signature): `MISSING`

**Recommended fixture category:** `refactor`

---

### B3. Delete Declaration + Keep Call Site (Use-After-Delete)

**Description:** Branch A deletes a function, class, or constant declaration (intentional removal). Branch B adds a new file that calls or imports the now-deleted symbol. Text merge succeeds (A's deletion lands cleanly; B's new file compiles against the old state); the merged tree has a dangling reference.

**Distinction from B1:** B1 is about renaming (the symbol exists under a new name); B3 is about deletion (the symbol no longer exists at all). The correct response may differ: B1 can often be auto-fixed by propagating the rename; B3 may be a legitimate dilemma (was B's new code written knowing A would delete it?).

**Minimal TypeScript example:**

```typescript
// base: helpers.ts
export function formatDate(d: Date): string { ... }

// branch_a: deletes formatDate entirely (dead code removal)
// branch_b: adds dashboard.ts that imports and calls formatDate

// merged: formatDate is gone; dashboard.ts fails at tsc
```

**Sharp coverage:** `PARTIAL` — `delete_edit/ts/delete_then_edit` and `delete_edit/rust/delete_then_edit` cover the case where B _edits the deleted file_, not where B _adds a new caller_. A scenario where B creates a fresh file importing the deleted symbol is `MISSING`.

**Recommended fixture category:** `cross_file_rename` or `delete_edit`

---

### B4. Type Narrowing Breakage After Merge

**Description:** Branch A narrows or tightens a type definition (e.g., changes `string | null` to `string`, or replaces a wide interface with a discriminated union). Branch B adds code that works with the old, wider type. Text merge succeeds; the new code fails type checking because it handles cases that no longer exist, or omits required narrowing.

**Minimal TypeScript example:**

```typescript
// base: types.ts
export type UserId = string | number;

// branch_a: narrows to string only
export type UserId = string;

// branch_b: adds validation.ts that calls parseInt(userId) -- valid for number
// merged: UserId is string; parseInt(userId) is now a type error
```

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `refactor`

---

### B5. Import Path Rename + Stale Import in New File

**Description:** Branch A renames or reorganises the module path (moves a file, changes the package structure). All existing imports in existing files are updated. Branch B adds a new file with an import of the old path. Text merge succeeds; the new file has a broken import.

**Minimal TypeScript example:**

```typescript
// base: src/utils/helpers.ts exports parseConfig

// branch_a: moves to src/config/parser.ts; updates all existing imports
// branch_b: adds src/api/route.ts that imports from '../utils/helpers'

// merged: helpers.ts is gone; route.ts has broken import
```

**Sharp coverage:** `PARTIAL` — `move_edit/ts/move_then_edit` covers file move + direct edit of the moved file; the stale-import-in-new-file variant is `MISSING`.

**Recommended fixture category:** `move_edit` or `cross_file_rename`

---

### B6. Function Move to Different File + Caller in Third File

**Description:** Branch A extracts a function from file X into file Y (splits a module). Existing callers in file X are updated to import from Y. Branch B adds a third file that calls the function from its original location (file X). Text merge succeeds; the third file has a broken import.

**This differs from B5** in that the function still exists — it has just moved. The symbol's new location is deterministic and the fix is mechanical (update the import path), making this a strong candidate for Sharp auto-resolution.

**Sharp coverage:** `PARTIAL` — `move_edit/` scenarios cover the git-level move detection but do not cover the "new caller of old path" pattern. `MISSING` specifically.

**Recommended fixture category:** `move_edit`

---

### B7. Interface/Trait Change + Stale Implementor

**Description:** Branch A changes an interface or trait (adds a required method, changes a method signature, removes a method). All _existing_ implementors are updated. Branch B adds a new struct/class that implements the old interface. Text merge succeeds; the new implementor is missing a required method or has a wrong signature.

**Minimal TypeScript example:**

```typescript
// base: interfaces.ts
interface Serializable {
  serialize(): string;
}

// branch_a: adds required deserialize() method to interface; updates all existing implementors
// branch_b: adds LogEntry class implementing old Serializable (only serialize())

// merged: LogEntry is missing deserialize() -> tsc error
```

**Minimal Rust example:**

```rust
// base: trait.rs
trait Printable {
    fn print(&self);
}

// branch_a: adds fn summary(&self) -> String to trait; updates all impls
// branch_b: adds struct Report that implements old Printable (only print())

// merged: Report missing summary() -> cargo check error
```

**Sharp coverage:** `MISSING` (no `trait_impl` or `interface_impl` scenario exists)

**Recommended fixture category:** `refactor`

---

### B8. Enum Variant Addition/Removal + Switch Exhaustiveness

**Description:** Branch A adds a new variant to an enum (or removes one). Branch B adds a new `switch` / `match` that handles all _current_ variants. After merge, the switch is non-exhaustive (missing the new variant) or has a dead case (handles the removed variant).

**Sub-variants:**

- **B8a. Variant addition** — branch A adds `Cancelled` to `Status`; branch B adds a match that doesn't handle `Cancelled`.
- **B8b. Variant removal** — branch A removes `Legacy` from `Status`; branch B adds a match with a `Legacy` arm (dead code or compile error).

**Minimal TypeScript example (B8a):**

```typescript
// base: status.ts
export type Status = 'active' | 'inactive';

// branch_a adds "pending":
export type Status = 'active' | 'inactive' | 'pending';

// branch_b adds handler.ts with exhaustive switch over "active" | "inactive"
function handle(s: Status) {
  switch (s) {
    case 'active':
      return doActive();
    case 'inactive':
      return doInactive();
    default:
      assertNever(s); // 'pending' now reaches here -> type error
  }
}
// merged: tsc error on assertNever branch
```

**Minimal Rust example (B8a):**

```rust
// base: state.rs
enum State { Running, Stopped }

// branch_a adds Paused variant
// branch_b adds a match {} without Paused arm -> non-exhaustive match error
```

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `refactor`

---

### B9. API Contract Change (Return Type, Error Handling) + Consumer

**Description:** Branch A changes a function's contract: return type changes (e.g., `number` to `Result<number, Error>`, or `T` to `T | null`), error-handling strategy changes (throws vs. returns error), or async/sync changes. Existing consumers in existing files are updated. Branch B adds a new consumer that works with the old contract.

**Minimal TypeScript example:**

```typescript
// base: api.ts
export function fetchUser(id: string): User { ... }  // sync, throws on error

// branch_a: changes to async, returns Promise<User | null> instead
// branch_b: adds reporter.ts that calls fetchUser(id).name  (sync, no null check)

// merged: fetchUser returns Promise; reporter.ts does .name on a Promise -> error
```

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `refactor`

---

### B10. Dependency Version Bump + Incompatible API Usage in Other Branch

**Description:** Branch A bumps a library dependency to a new major version that changes its API. `package.json` / `Cargo.toml` is updated; existing usage in existing files is migrated. Branch B adds new code that uses the old API of the library. Text merge succeeds; the new code fails because it uses the old API.

**Minimal example:**

```
// base: package.json has "lodash": "^3.0.0"
// branch_a: bumps to "lodash": "^4.0.0"; migrates all _.pluck() -> _.map() calls
// branch_b: adds analytics.ts that uses _.pluck() (removed in lodash 4)
// merged: tsc/runtime error on _.pluck()
```

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `refactor` or a new `dependency_bump` category

**Design note:** This category requires a minimal vendored or stub dependency to test without network access. The validator must check the caller's code against the stub, not the real library.

---

### B11. Concurrent Same-Symbol Addition (Add/Add on Identical Names)

**Description:** Both branches independently create a new function, class, or variable with the _same name_ in the same file. Git may produce a conflict (if the additions land at the same position) or silently include both definitions (if they land at different positions). If both definitions are included, the merged result has duplicate exports or redeclaration errors.

**Sub-variants:**

- **B11a. Same position** — git flags a conflict (false negative for Sharp to resolve).
- **B11b. Different positions** — git silently includes both; compiler catches duplicate.

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `reorder` (B11a) or `refactor` (B11b)

---

### B12. Global State / Singleton Mutation Conflict

**Description:** Both branches independently modify a globally shared mutable object or configuration (module-level variable, global registry, global configuration object) in ways that are textually disjoint but semantically incompatible. The merged result compiles but has incorrect runtime behaviour because both mutations are applied, producing an unintended combined state.

**Example:** Branch A sets a global feature flag to `true`; branch B sets a different flag to `false`. Both changes land in the merged result, but both together violate an invariant assumed by both branches.

**Sharp coverage:** `MISSING`

**Recommended fixture category:** A new `config_conflict` category, or `refactor`

**Note:** This is also a C-category (legitimate conflict) candidate. It is classified as B here because git produces a clean merge and the problem is only visible at runtime.

---

### B13. Duplicate Import After Merge

**Description:** Both branches add the same import statement (e.g., both add `import { useState } from 'react'`). Git silently includes both import lines in the merged output. TypeScript and most bundlers tolerate duplicate imports, but linters and some compilers flag them.

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `import_merge`

**Design note:** This is a mild false positive — the code usually still works, but the output is technically incorrect (contains a duplicate). The correct merge includes the import exactly once.

---

### B14. Moved File + Stale Import in Pre-existing File

**Description:** Branch A moves a file (rename). Branch B modifies a _different_, pre-existing file that imports from the old path. Git's rename detection applies to the moved file, but the stale import in B's modification is not flagged. The merged tree has B's modified file importing from the now-deleted path.

**Distinction from B5/B6:** Here the stale import is in a file that B _modified_ (not created), so the file appears in B's diff. Git processes B's change cleanly (the modified file's lines that B changed don't overlap with A's rename). The breakage is the import statement that B didn't touch, which now points to a non-existent path.

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `move_edit`

---

## Section C: Legitimate Conflicts — Human Judgment Genuinely Required

These are cases where git is _correct_ to report a conflict (or would be correct if it had more semantic awareness), and where the correct resolution is genuinely ambiguous without additional context. Sharp's role is to confirm the conflict is real, gather evidence (oracle branches, type checker output, commit messages), and escalate via a structured Tier 3 dilemma rather than guessing.

---

### C1. Both Branches Edit the Same Function Body in Incompatible Ways

**Description:** Both branches make substantive semantic changes to the same function. The changes are not independent: they reflect different implementation decisions for the same logical unit, and applying both simultaneously produces code that is either nonsensical or semantically wrong in a way that cannot be mechanically resolved.

**Minimal TypeScript example:**

```typescript
// base
function calculateDiscount(price: number, tier: string): number {
  return tier === 'premium' ? price * 0.8 : price * 0.9;
}

// branch_a: implements tiered discount from a lookup table
function calculateDiscount(price: number, tier: string): number {
  const rates: Record<string, number> = { premium: 0.75, standard: 0.85, basic: 0.95 };
  return price * (rates[tier] ?? 1);
}

// branch_b: adds percentage-based override parameter
function calculateDiscount(price: number, tier: string, override?: number): number {
  if (override !== undefined) return price * (1 - override);
  return tier === 'premium' ? price * 0.8 : price * 0.9;
}

// Both changes are incompatible: B's override doesn't work with A's rate table
// git CONFLICT; no mechanical resolution
```

**Sharp coverage:** `PARTIAL` — this pattern is exercised incidentally in some scenarios but there is no dedicated fixture for pure algorithmic divergence in a function body.

**Recommended fixture category:** A new category `algorithmic_divergence`, or `refactor`

---

### C2. Both Branches Change the Same Type Definition Incompatibly

**Description:** Both branches independently modify the same type, interface, or struct in ways that are mutually exclusive: one branch adds a field the other branch removes, or both rename the same field to different names, or both change the same field's type.

**Minimal TypeScript example:**

```typescript
// base: types.ts
interface User {
  id: string;
  name: string;
  email: string;
}

// branch_a: renames email -> emailAddress; adds phone field
// branch_b: removes email; adds preferences field

// Conflict: both branches delete email but in different ways with different replacements
```

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `refactor`

---

### C3. Delete-Then-Edit (Modify/Delete Conflict)

**Description:** Branch A deletes a file. Branch B edits the same file. Git correctly flags this as a conflict because the outcome depends on intent: was A's deletion deliberate, and should B's edits be discarded? Or was A's deletion premature, and should the file survive with B's edits? This is a Tier 3 dilemma.

**Sharp coverage:** `COVERED`

- `delete_edit/ts/delete_then_edit`
- `delete_edit/rust/delete_then_edit`

**Recommended fixture category:** `delete_edit`

**Design note:** The `expected_sharp_outcome: dilemma` classification is correct. Sharp should present both candidate trees (keep-with-edit and delete) to the calling agent.

---

### C4. Algorithmic Divergence (Both Branches Implement Same Requirement Differently)

**Description:** Both branches implement the same new feature or fix the same bug but with different algorithms. The feature is new in both branches (it was not in the base), so git flags the conflict because both branches add code to the same region. But unlike A1-A4 (independent additions), these additions are logically exclusive: both cannot co-exist.

**Minimal example:**

```typescript
// base: sort.ts — no sort function

// branch_a: adds bubble sort implementation
export function sort(arr: number[]): number[] {
  /* bubble sort */
}

// branch_b: adds merge sort implementation
export function sort(arr: number[]): number[] {
  /* merge sort */
}

// git CONFLICT (same name, same location)
// Sharp cannot pick: both are valid sorts; dilemma required
```

**Sharp coverage:** `MISSING`

**Recommended fixture category:** A new `algorithmic_divergence` category

---

### C5. Configuration Divergence (Different Feature Flags or Defaults)

**Description:** Both branches modify the same configuration file, setting incompatible values for the same key. One branch enables a feature flag; the other disables it. Or both change the same default value to different values. Neither is "obviously right"; the correct value depends on product/business context that is not in the code.

**Minimal example:**

```typescript
// base: config.ts
export const MAX_RETRIES = 3;

// branch_a: MAX_RETRIES = 5  (performance tuning)
// branch_b: MAX_RETRIES = 1  (cost reduction)

// git CONFLICT; Sharp cannot determine which is correct
```

**Sharp coverage:** `MISSING`

**Recommended fixture category:** A new `config_conflict` category

---

### C6. Rename/Rename Conflict (Both Branches Rename Same Symbol Differently)

**Description:** Both branches rename the same file or symbol, but to different target names. Git flags this as `CONFLICT (rename/rename)`. This is a legitimate conflict: both renames represent valid choices, and the correct one depends on which branch's naming convention should win.

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `refactor` or `cross_file_rename`

---

### C7. Concurrent Incompatible Dependency Bumps

**Description:** Both branches bump the same dependency to different incompatible versions (`package.json` or `Cargo.toml`). Text-merge of the version strings produces a conflict on the version line. This is genuine: the project cannot simultaneously depend on two different major versions (in most package managers).

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `refactor` or `config_conflict`

---

### C8. Schema Migration Conflicts

**Description:** Both branches add migration scripts or schema change files that are independent in content but ordered: database migrations are sequential, and both branches adding a migration creates a conflict on the sequence number or on the shared migration directory. The correct resolution requires choosing an ordering, which may affect application correctness.

**Sharp coverage:** `MISSING`

**Recommended fixture category:** A new `schema_migration` category

---

### C9. Test Expectation vs. Implementation Change

**Description:** Branch A changes a function's behaviour. Branch B updates a test to expect the _old_ behaviour (written against the old implementation). Text merge succeeds; the test now fails. This is a semantic conflict: the test and implementation disagree, but the correct fix is not obvious from the text (does A's change or B's expectation win?).

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `refactor`

---

## Section D: Cross-Cutting Concerns and Edge Cases

These scenarios do not fit cleanly into A, B, or C. They involve multiple interacting mechanisms, span multiple files, or require context that goes beyond a single merge operation.

---

### D1. Text-Level Legitimate, AST-Level Auto-Resolvable

**Description:** Git reports a conflict because two changes overlap at the text level. At the AST level, however, the changes are to independent subtrees and can be merged mechanically. This is the core promise of structured/semantic merge tools.

**Examples:**

- Two method additions in the same class body that happen to be adjacent in the text but are independent AST children.
- Two property additions to the same object literal where the comma placement causes textual overlap.

**Sharp coverage:** `COVERED` (this is the core of `reorder/` and `format/` scenarios)

**Design note:** All of Section A is essentially "text-level conflict, AST-level auto-resolvable." Section D1 is the generalisation.

---

### D2. One Side Is Clearly Wrong (Clear Winner Conflict)

**Description:** A conflict exists at the text level, but one branch's version is obviously correct given additional context: one branch introduces a bug, or one branch's change is a copy-paste error that doesn't make sense. Git cannot determine this; it requires semantic understanding.

**Example:** Branch A fixes a bug in a calculation. Branch B accidentally duplicates the calculation. The merge conflict between them has an obvious winner (A's fix), but git presents both as equal.

**Sharp coverage:** `MISSING`

**Recommended fixture category:** This is a Tier 2 (oracle) scenario. Oracle branches (`branch_c/`) should demonstrate the correct resolution via tests or type-checking.

---

### D3. Multi-File Conflicts Where Individual Files Look Clean

**Description:** No single file has a conflict, but the _combination_ of changes across files is semantically broken. Classic example: A renames a function in file X; B renames a different function in file Y to the same new name. Each file merges cleanly, but the result has a naming collision that neither A nor B anticipated.

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `cross_file_rename`

---

### D4. Code Movement: Rename + Edit

**Description:** Branch A renames a file and makes minor edits to it. Branch B makes edits to the old filename. Git's rename detection (similarity threshold > 50%) should detect the rename and merge B's edits into the renamed file. If the rename is accompanied by content edits that reduce similarity below the threshold, git falls back to treating it as delete + add, losing B's edits.

**Sharp coverage:** `COVERED` (`move_edit/ts/move_then_edit`, `move_edit/rust/move_then_edit`)

**Missing variant:** File renamed _and_ substantially refactored (low similarity) + external edits: `MISSING`. This tests the boundary of git's rename detection heuristic.

---

### D5. Split File Conflict

**Description:** Branch A splits a large module into two smaller files (extracts part of the module into a new file, updating internal references). Branch B edits code in the original file in a region that was moved. Git sees the original file as "modified on A" (even though A's change was mostly deletion/extraction) and "modified on B" (B's actual edit). The merge may produce a conflict or a wrong result depending on where exactly B's edits landed.

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `move_edit` or a new `split_file` category

---

### D6. Merge File Conflict (Inverse of Split)

**Description:** Branch A merges two files into one (consolidates modules, collapses a small utility into its only consumer). Branch B edits one of the files that A absorbed. Git sees a delete on A's side (the absorbed file is gone) and an edit on B's side — a modify/delete conflict. But the correct resolution is to apply B's edit to the relevant section of A's consolidated file.

**Sharp coverage:** `MISSING`

**Recommended fixture category:** `delete_edit` or `move_edit`

---

### D7. Criss-Cross Merge (Diamond Merge History)

**Description:** A criss-cross merge occurs when two branches have been merged into each other previously, creating a diamond-shaped merge topology. When a third merge is attempted, git's `recursive` merge strategy may choose the wrong merge base, causing false conflicts or incorrect resolution. Git's `ort` strategy (default since 2.34) handles this better but not perfectly.

**Example topology:**

```
      A
     / \
    B   C
     \ /
      D (merge B+C)
     / \
    E   F
     \ /
      G (criss-cross)
```

**Sharp coverage:** `MISSING` (requires a multi-commit scenario; beyond the current two-branch fixture model)

---

### D8. Submerged Conflict (Conflict Inside a Reverted Merge)

**Description:** A previous merge was reverted. When the reverted branch is later re-merged, git does not re-apply the reverted changes because the revert commit appears in the common ancestor's history. The result is that expected changes are silently absent from the merged tree.

**Sharp coverage:** `MISSING`

---

### D9. Binary File Conflicts

**Description:** Both branches modify a binary file (image, PDF, compiled artifact, protobuf schema). Git cannot perform a three-way diff on binary content and will either flag a conflict or silently take one side (depending on strategy). The correct resolution depends on the binary's semantics, which git cannot inspect.

**Sharp coverage:** `MISSING` (binary files are edge cases for a code-focused semantic merger)

**Note:** Sharp's semantic layer (Tree-sitter, symbol tables) does not apply to true binary files. Binary file conflict handling is likely out of scope for v1.

---

### D10. Lock File and Generated File Conflicts

**Description:** `bun.lock`, `package-lock.json`, `Cargo.lock`, or other machine-generated files conflict when both branches add or update dependencies. The lock file conflict is a false negative (the correct resolution is to re-run the package manager), but mechanically resolving it by concatenating lines produces an invalid lock file.

**Sharp coverage:** `MISSING`

**Note:** The correct resolution for lock file conflicts is not a merge — it is a re-generation. Sharp should detect this pattern and escalate appropriately rather than attempting a text merge.

---

### D11. Rebase-Introduced Conflicts That Would Not Exist on Merge

**Description:** When rebasing branch B onto branch A's tip, conflicts may appear that would not exist if B were merged into A. This is because rebase replays B's commits one at a time against A's state, and intermediate commits in B may temporarily conflict with A's state even though the final state of B is compatible.

**Sharp coverage:** `MISSING` (Sharp v1 uses a single merge model, not rebase; relevant to document for future reference)

---

### D12. Conflict Caused by Macro / Code Generation Expansion

**Description:** One branch modifies a macro definition; the other branch modifies code generated or expanded from that macro. At the source level, there is no textual overlap. After macro expansion, the generated code conflicts. This pattern is common in Rust (derive macros, proc macros) and TypeScript (code generation from OpenAPI specs).

**Sharp coverage:** `MISSING`

---

## Coverage Summary Table

| ID  | Description                                                | git outcome             | Sharp outcome       | Sharp coverage            |
| --- | ---------------------------------------------------------- | ----------------------- | ------------------- | ------------------------- |
| A1  | Adjacent-line insertion (hunk adjacency)                   | conflict                | clean_ok            | COVERED (4 scenarios)     |
| A2  | Parallel function/method additions to same region          | conflict                | clean_ok            | COVERED                   |
| A3a | Parallel import additions (pure)                           | conflict                | clean_ok            | COVERED                   |
| A3b | Parallel import + body change                              | conflict                | dilemma             | COVERED (dilemma)         |
| A4a | Parallel struct/object property additions                  | conflict                | clean_ok            | COVERED                   |
| A4b | Parallel enum variant additions                            | conflict                | clean_ok            | MISSING                   |
| A4c | Parallel TypeScript interface field additions              | conflict                | clean_ok            | MISSING                   |
| A5  | Whitespace reformat vs. semantic edit                      | conflict                | clean_ok            | COVERED                   |
| A6  | Reindentation (wrap/unwrap) vs. edit inside                | conflict                | clean_ok            | MISSING                   |
| A7  | Comment-only change vs. nearby semantic edit               | conflict                | clean_ok            | MISSING                   |
| A8  | CRLF/LF normalisation + semantic edit                      | conflict                | clean_ok            | MISSING                   |
| A9  | Trailing newline addition + edit of last line              | conflict                | clean_ok            | MISSING                   |
| A10 | Both branches delete same lines identically                | conflict                | clean_ok            | MISSING                   |
| A11 | File mode change vs. content edit                          | conflict                | clean_ok            | MISSING                   |
| A12 | Submodule pointer vs. unrelated file edit                  | conflict                | clean_ok            | MISSING (out of v1 scope) |
| B1  | Cross-file symbol rename + stale name in new file          | clean_wrong             | clean_ok            | COVERED (4 scenarios)     |
| B2a | Signature change (arity) + new caller with old signature   | clean_wrong             | clean_ok            | COVERED                   |
| B2b | Signature change (param type) + new caller                 | clean_wrong             | clean_ok            | MISSING                   |
| B2c | Return type change + new consumer                          | clean_wrong             | clean_ok            | MISSING                   |
| B3  | Delete declaration + new caller of deleted symbol          | clean_wrong             | dilemma             | MISSING                   |
| B4  | Type narrowing + new code using wide type                  | clean_wrong             | clean_ok            | MISSING                   |
| B5  | Import path rename + stale import in new file              | clean_wrong             | clean_ok            | MISSING                   |
| B6  | Function move to new file + caller of old path in new file | clean_wrong             | clean_ok            | MISSING                   |
| B7  | Interface/trait change + stale implementor                 | clean_wrong             | clean_ok            | MISSING                   |
| B8a | Enum variant addition + non-exhaustive switch              | clean_wrong             | clean_ok            | MISSING                   |
| B8b | Enum variant removal + dead switch arm                     | clean_wrong             | clean_ok            | MISSING                   |
| B9  | API contract change (async, null, Result) + new consumer   | clean_wrong             | clean_ok            | MISSING                   |
| B10 | Dependency version bump + incompatible usage in new code   | clean_wrong             | clean_ok            | MISSING                   |
| B11 | Same-name addition (add/add)                               | conflict or clean_wrong | clean_ok or dilemma | MISSING                   |
| B12 | Global state mutation — both branches modify same global   | clean_wrong             | dilemma             | MISSING                   |
| B13 | Duplicate import after merge                               | clean_wrong             | clean_ok            | MISSING                   |
| B14 | File move + stale import in modified (not new) file        | clean_wrong             | clean_ok            | MISSING                   |
| C1  | Both branches edit same function body incompatibly         | conflict                | dilemma             | PARTIAL                   |
| C2  | Both branches change same type incompatibly                | conflict                | dilemma             | MISSING                   |
| C3  | Delete-then-edit (modify/delete)                           | conflict                | dilemma             | COVERED                   |
| C4  | Algorithmic divergence (same feature, different impl)      | conflict                | dilemma             | MISSING                   |
| C5  | Configuration divergence (different defaults/flags)        | conflict                | dilemma             | MISSING                   |
| C6  | Rename/rename conflict                                     | conflict                | dilemma             | MISSING                   |
| C7  | Concurrent incompatible dependency bumps                   | conflict                | dilemma             | MISSING                   |
| C8  | Schema migration ordering conflict                         | conflict                | dilemma             | MISSING                   |
| C9  | Test expectation vs. implementation change                 | clean_wrong             | dilemma             | MISSING                   |
| D1  | Text-level conflict, AST-level auto-resolvable             | conflict                | clean_ok            | COVERED (core premise)    |
| D2  | One side is clearly wrong (clear winner)                   | conflict                | clean_ok            | MISSING                   |
| D3  | Multi-file: individual files clean, cross-file broken      | clean_wrong             | clean_ok            | MISSING                   |
| D4a | File rename + external edit (high similarity)              | conflict                | clean_ok            | COVERED                   |
| D4b | File rename + refactor + external edit (low similarity)    | conflict                | dilemma             | MISSING                   |
| D5  | Split file: original edited, extracted portion conflicts   | conflict or clean_wrong | clean_ok            | MISSING                   |
| D6  | Merge file: absorbed file edited on other branch           | conflict                | clean_ok            | MISSING                   |
| D7  | Criss-cross merge (diamond history)                        | conflict                | —                   | MISSING                   |
| D8  | Submerged conflict (revert then re-merge)                  | clean_wrong             | —                   | MISSING                   |
| D9  | Binary file conflict                                       | conflict                | dilemma             | MISSING                   |
| D10 | Lock file / generated file conflict                        | conflict                | escalate            | MISSING                   |
| D11 | Rebase-only conflict (not a merge conflict)                | conflict                | —                   | MISSING (out of scope)    |
| D12 | Macro / code generation expansion conflict                 | clean_wrong             | —                   | MISSING                   |

---

## Priority Fixture Backlog

The following new fixtures are recommended as highest priority, ordered by frequency in real-world codebases and difficulty for git:

### Tier 1: High-value false negatives (Section A) — easy to write, immediately improves Sharp's Tier 1 auto-resolve rate

1. **`reorder/ts/parallel_enum_variant_additions`** (A4b) — Two branches add independent enum variants. TS variant.
2. **`reorder/rust/parallel_enum_variant_additions`** (A4b) — Rust enum variant additions. Rust variant.
3. **`reorder/ts/parallel_interface_field_additions`** (A4c) — Two branches add independent interface fields. TS variant.
4. **`format/ts/wrap_then_edit`** (A6) — Branch A wraps code in `if`; branch B edits inside the block.
5. **`format/rust/wrap_then_edit`** (A6) — Rust equivalent of wrap-then-edit.
6. **`format/ts/comment_vs_semantic_edit`** (A7) — Comment update adjacent to semantic edit.
7. **`import_merge/ts/duplicate_import_after_merge`** (B13) — Both branches add the same import.

### Tier 2: High-value false positives (Section B) — require validators; catch silent semantic breaks

8. **`refactor/ts/param_type_change_with_new_caller`** (B2b) — Parameter type narrowed; new caller passes wrong type.
9. **`refactor/ts/return_type_change_with_new_consumer`** (B2c) — Return type changed; new consumer uses old type.
10. **`refactor/rust/trait_impl_change_stale_implementor`** (B7) — Trait gains a required method; new impl is incomplete. Rust variant.
11. **`refactor/ts/interface_change_stale_implementor`** (B7) — Interface gains required method; new class is stale. TS variant.
12. **`refactor/ts/enum_variant_add_exhaustive_switch`** (B8a) — Enum gains variant; new switch is non-exhaustive.
13. **`refactor/rust/enum_variant_add_exhaustive_match`** (B8a) — Rust enum + non-exhaustive match.
14. **`refactor/ts/api_contract_async_change_new_consumer`** (B9) — Sync-to-async change; new caller is sync.
15. **`cross_file_rename/ts/delete_decl_new_caller`** (B3) — Delete export; new file imports deleted symbol.
16. **`move_edit/ts/import_path_rename_new_file`** (B5) — File moved; new file imports from old path.

### Tier 3: Legitimate conflicts (Section C) — require `expected_sharp_outcome: dilemma`; test Tier 3 escalation

17. **`refactor/ts/incompatible_type_change`** (C2) — Both branches change same interface incompatibly.
18. **`refactor/ts/algorithmic_divergence`** (C4) — Both branches implement same new function with different algorithms.
19. **`config_conflict/ts/feature_flag_divergence`** (C5) — Both branches set same config key to different values.
20. **`refactor/ts/rename_rename_conflict`** (C6) — Both branches rename same symbol to different names.

---

## Designing Fixtures for Each Category

### False Negative Fixtures (Section A)

**Goal:** `expected_git_outcome: conflict`, `expected_sharp_outcome: clean_ok`.

**Recipe:**

1. `base/` contains the shared ancestor.
2. `branch_a/` makes change X to region R.
3. `branch_b/` makes change Y to region R, where X and Y are independent.
4. Confirm `git merge branch_b` from branch_a produces conflict markers.
5. `expected/` contains the correct merged result (both X and Y applied).
6. Validator confirms the merged tree compiles.

**Key discipline:** The changes must be textually overlapping (same hunk) but semantically independent. If they are truly disjoint (different files or clearly separate hunks), git will merge them automatically and the fixture is invalid.

### False Positive Fixtures (Section B)

**Goal:** `expected_git_outcome: clean_wrong`, `expected_sharp_outcome: clean_ok`.

**Recipe:**

1. `base/` contains the shared ancestor.
2. `branch_a/` makes changes to _existing_ files.
3. `branch_b/` adds a _new file_ (or modifies a _different_ file) that references the symbols A changed.
4. Confirm `git merge branch_b` produces no conflict markers but the merged tree fails tsc/cargo check.
5. `expected/` contains the correct merged result (A's semantic change propagated to B's new code).
6. Validator confirms the corrected merged tree compiles.

**Key discipline:** The branches must modify _disjoint_ sets of files. Any textual overlap converts the scenario from B to A (false negative) or C (legitimate conflict).

### Legitimate Conflict Fixtures (Section C)

**Goal:** `expected_git_outcome: conflict`, `expected_sharp_outcome: dilemma`.

**Recipe:**

1. `base/` contains the shared ancestor.
2. Both branches modify the _same_ semantic unit in incompatible ways.
3. Confirm `git merge` produces conflict markers.
4. Do _not_ provide `expected/` (there is no single correct answer).
5. Add `notes:` explaining why neither candidate is automatically correct.
6. Optionally add `branch_c/`, `branch_d/` as oracle branches if the test explores Sharp's Tier 2 tie-break behaviour.

---

## References and Further Reading

The following sources informed this taxonomy:

- Fowler, M. "Semantic Conflict." martinfowler.com. (Semantic conflicts caused by method rename + parallel caller addition; self-testing code as mitigation.)
- Haacked, P. "When Git Resolves Changes It Shouldn't." haacked.com, 2019. (Duplicate imports, divergent interface property moves.)
- Haacked, P. "Banish Merge Conflicts With Semantic Merge." haacked.com, 2019. (Interface split + parallel method extraction.)
- Sousa, M. et al. "Verifying Semantic Conflict-Freedom in Three-Way Program Merges." arXiv:1802.06551. (SafeMerge; semantic conflict verification; false positive cases in kdiff3.)
- Cavalcanti, G. et al. "Detecting Semantic Conflicts Via Automated Behavior Change Detection." IEEE TSE / SPGroup, 2019. (Empirical study; 38 GitHub merge scenarios; false negative analysis.)
- Nguyen, T. et al. "An Analysis of Merge Conflicts and Resolutions in Git-Based Open Source Projects." Semantic Scholar. (Large-scale empirical study; semistructured merge false negative rates.)
- Win-Vector Blog. "Resolving git pseudo-conflicts." win-vector.com, 2013. (Identical-both-sides edits; intermediate commit conflicts.)
- Atlassian. "Git Advanced Merging." git-scm.com/book. (Whitespace conflicts; revert-then-remerge; subtree merges.)
- Thomson, E. "Advent Day 21: Renormalizing Line Endings." edwardthomson.com. (CRLF/LF false conflicts; `merge.renormalize`.)
- git-scm.com. "git-merge-tree documentation." (Conflict types: modify/delete, rename/rename, rename/delete, add/add, directory/file, mode, submodule.)
- paulaltin/git-hires-merge. GitHub. (Character-level merge driver for resolving individual-line adjacent conflicts.)
