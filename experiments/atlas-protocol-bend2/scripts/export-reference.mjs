import { mkdir, writeFile } from 'node:fs/promises';
import reference from '../dist/reference.mjs';

function array(list) {
  const values = [];
  for (let item = list; item.$ === 'Con'; item = item.tail) values.push(item.head);
  return values;
}
function json(value) {
  switch (value.$) {
    case 'JNull':
      return null;
    case 'JBool':
    case 'JStr':
      return value.value;
    case 'JNum':
      return Number(value.raw);
    case 'JArr':
      return array(value.items).map(json);
    case 'JObj':
      return Object.fromEntries(array(value.members).map(({ key, value }) => [key, json(value)]));
    default:
      throw new Error(`Invalid reference value ${value.$}`);
  }
}
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
const document = json(reference.document());
await writeFile(
  new URL('../artifacts/reference-source.json', import.meta.url),
  JSON.stringify(document, null, 2) + '\n',
);
console.log(`Exported ${Object.keys(document.paths).length} operations from Bend schema data.`);
