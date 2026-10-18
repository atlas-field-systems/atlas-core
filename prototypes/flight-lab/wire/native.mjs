import { readFileSync } from 'node:fs';

const inputs = JSON.parse(readFileSync(0, 'utf8'));
const outputs = inputs.map(input => {
  try {
    const value = JSON.parse(Buffer.from(input, 'base64').toString('utf8'));
    const nonfinite = [];
    function inspect(item, path) {
      if (typeof item === 'number' && !Number.isFinite(item)) nonfinite.push(path);
      if (item && typeof item === 'object') {
        for (const [key, child] of Object.entries(item)) inspect(child, `${path}/${key}`);
      }
    }
    inspect(value, '');
    return { accepted: true, value, nonfinite };
  } catch (error) {
    return { accepted: false, error: error.message };
  }
});
process.stdout.write(JSON.stringify(outputs));
