// Fixture for semantic-diagnostics tests.
// This file intentionally contains a type error: `add` expects two numbers but
// receives a string as its second argument.  tsserver should report error 2345.
function add(a: number, b: number): number {
  return a + b;
}

const result = add(1, "two");
console.log(result);
