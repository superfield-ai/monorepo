// Fixture for rename-location enumeration tests.
// The symbol `greet` is defined on line 1 and called on line 5.
// A rename request at (1, 10) should return both occurrences.
function greet(name: string): string {
  return `Hello, ${name}!`;
}

const message = greet("world");
console.log(message);
