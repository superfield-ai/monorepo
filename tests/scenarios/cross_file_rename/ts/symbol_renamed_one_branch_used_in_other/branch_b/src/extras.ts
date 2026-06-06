// Branch B introduced this file with a fresh use of the OLD class name.
import { HttpClient } from './api';

export function makeClient(): HttpClient {
  return new HttpClient();
}
