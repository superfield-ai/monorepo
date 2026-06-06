import { RestClient } from './api';

const client = new RestClient();
console.log(client.fetch('https://example.com'));
