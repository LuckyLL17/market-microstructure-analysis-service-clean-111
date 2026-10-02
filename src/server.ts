import { MarketEngine } from './engine.js';
import { buildApp } from './app.js';

const app = buildApp(new MarketEngine());

await app.listen({ port: 6190, host: '127.0.0.1' });
