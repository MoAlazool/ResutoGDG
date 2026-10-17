import 'reflect-metadata';
import { main } from './bootstrap';

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
