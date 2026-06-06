import { sum } from './math';

export function average(values: number[]): number {
  return sum(values[0], values[1]) / 2;
}
