export function greet(name: string, polite: boolean = false): string {
  return `${polite ? 'good day' : 'hello'}, ${name}`;
}
