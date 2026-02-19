#!/usr/bin/env node
/**
 * Post-build analysis script that examines what adapter-vercel bundled.
 * Run from an app directory after `vite build` to see function size,
 * file count, handler path, and any system directories that got swept in.
 *
 * Usage: node ../../scripts/analyze-build-output.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const appDir = process.cwd();
const outputDir = path.join(appDir, '.vercel', 'output', 'functions');

console.log('\n========================================');
console.log('  NFT Bundle Analysis (post-build)');
console.log('========================================\n');

if (!fs.existsSync(outputDir)) {
  console.log('No .vercel/output/functions/ directory found. Skipping analysis.');
  process.exit(0);
}

// Find all .func directories
function findFuncDirs(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.func')) {
        results.push(full);
      } else {
        results.push(...findFuncDirs(full));
      }
    }
  }
  return results;
}

// Recursively get all files with sizes
function walkFiles(dir, base = dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, base));
    } else {
      const stat = fs.statSync(full);
      results.push({ path: path.relative(base, full), size: stat.size });
    }
  }
  return results;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

const funcDirs = findFuncDirs(outputDir);

if (funcDirs.length === 0) {
  console.log('No .func directories found in output.');
  process.exit(0);
}

for (const funcDir of funcDirs) {
  const funcName = path.relative(outputDir, funcDir);
  console.log(`\nFunction: ${funcName}`);
  console.log('-'.repeat(50));

  // Read .vc-config.json
  const vcConfigPath = path.join(funcDir, '.vc-config.json');
  if (fs.existsSync(vcConfigPath)) {
    const vcConfig = JSON.parse(fs.readFileSync(vcConfigPath, 'utf-8'));
    console.log(`  Handler: ${vcConfig.handler}`);
    console.log(`  Runtime: ${vcConfig.runtime}`);
    if (vcConfig.handler.includes('vercel/path0')) {
      console.log(`  ⚠ Handler contains "vercel/path0" — common ancestor likely dropped to /`);
    }
  }

  // Analyze all files in the function
  const files = walkFiles(funcDir);
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  console.log(`  Total files: ${files.length}`);
  console.log(`  Total size: ${formatSize(totalSize)}`);

  // Group by top-level directory
  const groups = {};
  for (const f of files) {
    const topDir = f.path.split(path.sep)[0] || '(root)';
    if (!groups[topDir]) groups[topDir] = { count: 0, size: 0 };
    groups[topDir].count++;
    groups[topDir].size += f.size;
  }

  console.log(`\n  Top-level directories:`);
  const sorted = Object.entries(groups).sort((a, b) => b[1].size - a[1].size);
  for (const [dir, info] of sorted) {
    console.log(`    ${dir}: ${info.count} files, ${formatSize(info.size)}`);
  }

  // Flag suspicious system directories
  const systemDirPatterns = ['uv', 'node22', 'node20', 'node18', '.vercel', 'usr', 'opt', 'tmp'];
  const suspiciousDirs = sorted.filter(([dir]) =>
    systemDirPatterns.some(p => dir.toLowerCase().startsWith(p))
  );

  if (suspiciousDirs.length > 0) {
    console.log(`\n  ⚠ SYSTEM DIRECTORIES DETECTED IN BUNDLE:`);
    for (const [dir, info] of suspiciousDirs) {
      console.log(`    ${dir}: ${info.count} files, ${formatSize(info.size)}`);
    }
    console.log(`\n  This confirms the NFT tracing bug — system files are being bundled.`);
    console.log(`  See: https://github.com/sveltejs/kit/issues/13764`);
  } else {
    console.log(`\n  ✓ No system directories detected in bundle.`);
  }
}

console.log('\n========================================\n');
