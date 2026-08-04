const fs = require('node:fs/promises');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const prismaClientRelativePaths = [
  path.join('dist', 'src', 'generated', 'prisma', 'client.js'),
  path.join('dist', 'generated', 'prisma', 'client.js'),
];

const importMetaSnippet = "globalThis['__dirname'] = path.dirname((0, node_url_1.fileURLToPath)(import.meta.url));";
const commonJsSnippet = "globalThis['__dirname'] = __dirname;";

async function patchFile(filePath) {
  try {
    const original = await fs.readFile(filePath, 'utf8');
    if (!original.includes(importMetaSnippet)) {
      return false;
    }

    const patched = original.replace(importMetaSnippet, commonJsSnippet);
    await fs.writeFile(filePath, patched, 'utf8');
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

async function main() {
  const patchedFiles = [];

  for (const relativePath of prismaClientRelativePaths) {
    const absolutePath = path.join(rootDir, relativePath);
    if (await patchFile(absolutePath)) {
      patchedFiles.push(relativePath);
    }
  }

  if (patchedFiles.length > 0) {
    console.log(`Patched Prisma CommonJS client: ${patchedFiles.join(', ')}`);
  } else {
    console.log('No Prisma CommonJS client patch needed.');
  }
}

main().catch((error) => {
  console.error('Failed to patch Prisma client output.');
  console.error(error);
  process.exit(1);
});
