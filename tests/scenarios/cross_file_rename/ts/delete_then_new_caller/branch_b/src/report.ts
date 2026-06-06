import { formatDate } from './helper';

export function generateReport(date: Date): string {
  return `Report generated: ${formatDate(date)}`;
}
