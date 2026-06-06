import { API_BASE } from './config';

export function fetchData(path: string): string {
  return `${API_BASE}${path}`;
}
