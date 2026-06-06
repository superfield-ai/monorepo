export function computeOrderTotal(
  items: ReadonlyArray<{ price: number; qty: number }>,
): number {
  let total = 0;
  for (const item of items) total += item.price * item.qty;
  return total;
}
