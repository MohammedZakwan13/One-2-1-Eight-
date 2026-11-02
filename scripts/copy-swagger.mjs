import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const source = path.join('node_modules', 'swagger-ui-dist');
const target = path.join('public', 'swagger');
if (!existsSync(source)) process.exit(0);
mkdirSync(target, { recursive: true });
for (const file of ['swagger-ui.css', 'swagger-ui-bundle.js']) copyFileSync(path.join(source, file), path.join(target, file));
