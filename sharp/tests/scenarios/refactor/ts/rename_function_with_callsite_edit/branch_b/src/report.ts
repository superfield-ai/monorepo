// Branch B adds a new module that calls the original symbol name. Branch A
// renamed that symbol in lib.ts; the rename never reaches this file because
// it didn't exist on branch_a. Text merge happily produces a tree where
// `lib.ts` exports `computeOrderTotal` and `report.ts` calls `computeTotal`.
import { computeTotal } from './lib';

export function reportTotals(items: ReadonlyArray<{ price: number; qty: number }>): string {
  return `Subtotal: ${computeTotal(items)}`;
}
