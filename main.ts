// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node /bot/main.ts`: it reads every case from
// /input/cases.json (a JSON array of { id, markdown }), renders each one
// on its own with parse() from ./parse.js, and writes /output/html.json —
// a JSON array of the HTML strings in the cases' order. For local runs,
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR can point at other folders.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as { id: string; markdown: string }[];

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
