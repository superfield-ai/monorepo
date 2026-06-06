import { HttpClient } from './api';

const client = new HttpClient();
console.log(client.fetch('https://example.com'));
