import { API_ENDPOINT } from './config';

export function fetchData(path: string): string {
  return `${API_ENDPOINT}${path}`;
}
