# SvelteKit + adapter-vercel NFT Tracing Bug Reproduction

Minimal reproduction for [sveltejs/kit#13764](https://github.com/sveltejs/kit/issues/13764).

## The Problem

When deploying a SvelteKit app that uses `@sveltejs/adapter-vercel` from within a **pnpm monorepo**, the `@vercel/nft` (Node File Trace) tool traces system files from the build environment, causing serverless function bundles to exceed the 250MB size limit.

### Root Cause

The issue is a chain of three interacting behaviors:

**1. SvelteKit inlines ALL `process.env` as string constants**

`$env/static/private` compiles every environment variable into a server chunk:

```javascript
const NODE = "/node22/bin/node";
const PATH = "/uv/bin:/node22/bin:/usr/local/bin:...";
const HOME = "/vercel";
// ... every process.env variable
```

**2. Vite merges the env chunk into a shared config chunk**

When multiple server-side routes import a shared Config module that uses `$env/static/private`, Vite's chunk splitting merges them together. This creates a **namespace object** with shorthand properties:

```javascript
const _private = Object.freeze(Object.defineProperty({
  __proto__: null,
  NODE,     // shorthand property — identifier read
  PATH,     // shorthand property — identifier read
  HOME,     // shorthand property — identifier read
  // ...
}, Symbol.toStringTag, { value: "Module" }));
```

**3. NFT treats shorthand properties as identifier reads**

`@vercel/nft`'s `isIdentifierRead()` returns `true` for shorthand `Property` nodes but `false` for `ExportSpecifier` nodes. So:

- `export { NODE }` — NFT **ignores** this (no file tracing)
- `{ NODE }` in Object.freeze — NFT **reads** this, resolves the string `"/node22/bin/node"`, and traces that path

On Vercel's build environment, this sweeps in system directories like `/proc`, `/pnpm10`, `/node24`, producing 250MB+ bundles.

### Why Only Some Apps Are Affected

The trigger is specifically **Vite's chunk merging**. A simple app with one route keeps `$env/static/private` in its own chunk with plain `export { ... }` specifiers (which NFT ignores). A realistic app with multiple routes sharing a Config module causes Vite to merge the env module into a shared chunk, generating the namespace object that NFT traces.

This repo demonstrates this with two apps:

- **`app-simple`** — Basic SvelteKit app with shared workspace packages. Builds clean (~1 MB function).
- **`app-with-flags`** — Same setup plus the [`flags`](https://www.npmjs.com/package/flags) package and multiple routes importing Config. Triggers NFT to trace system files, producing 250MB+ bundles on Vercel.

## Repository Structure

```
├── apps/
│   ├── app-simple/          # SvelteKit app — deploys successfully
│   └── app-with-flags/      # SvelteKit app with flags — exceeds 250MB on Vercel
├── packages/
│   ├── tsconfig/            # Shared TypeScript configs
│   ├── client-utils/        # Client-side utilities
│   └── server-libs/         # Server-side libraries (pino, graphql-request)
├── scripts/
│   ├── analyze-nft.mjs      # Diagnostic: runs NFT directly on an entry point
│   └── analyze-build-output.mjs  # Postbuild: logs bundle size and system dirs
```

Key characteristics that trigger the issue:
- **pnpm** package manager with workspace protocol (`workspace:*`)
- **pnpm catalog** for centralized version management
- **Turborepo** for build orchestration
- **Shared workspace packages** with npm dependencies (pino, graphql-request, etc.)
- **`$env/static/private`** usage (inlines env vars at build time)
- **`flags` package** with `flags/sveltekit` integration
- **Multiple server routes** importing a shared Config module (triggers Vite chunk merging)

## How to Reproduce

### Prerequisites

- Node.js >= 22
- pnpm >= 10
- A Vercel account

### Steps

1. **Clone this repo:**
   ```bash
   git clone <this-repo-url>
   cd sveltekit-vercel-nft-repro
   ```

2. **Install dependencies:**
   ```bash
   pnpm install
   ```

3. **Build locally:**
   ```bash
   pnpm build
   ```
   The `app-with-flags` build will crash during NFT tracing (attempting to trace 188K+ files from local filesystem paths). The `app-simple` build succeeds.

4. **Deploy to Vercel:**

   Import the repo on [vercel.com/new](https://vercel.com/new):
   - Set the root directory to `apps/app-with-flags`
   - Framework preset: SvelteKit
   - Node.js version: 22.x
   - Deploy

5. **Observe the results:**

   The postbuild analysis script logs bundle details in the Vercel build output:
   - Handler path with `vercel/path0/` prefix (common ancestor dropped to `/`)
   - System directories (`proc/`, `pnpm10/`, etc.) bundled into the function
   - Total bundle size exceeding 250MB

6. **Compare with the simple app:**

   Deploy `apps/app-simple` — it deploys successfully with ~1 MB function size.

## Debugging

### Postbuild analysis (runs automatically)

Both apps run `scripts/analyze-build-output.mjs` after each build, logging:
- Function size and file count
- Handler path from `.vc-config.json`
- Top-level directories in the bundle
- System directory detection warnings

### NFT trace analysis

Run NFT directly on an entry point:

```bash
node scripts/analyze-nft.mjs apps/app-with-flags/.svelte-kit/vercel-tmp/index.js
```

### Inspecting the compiled env chunk

After building, check how Vite compiled `$env/static/private`:

```bash
cat apps/app-with-flags/.svelte-kit/output/server/chunks/config.js
```

Look for the `_private = Object.freeze({ NODE, PATH, ... })` namespace object — this is what triggers NFT.

## Workaround

A patch that adds an `ignore` callback to `nodeFileTrace` resolves the issue. Add to `pnpm-workspace.yaml`:

```yaml
patchedDependencies:
  '@sveltejs/adapter-vercel@6.3.0': patches/@sveltejs__adapter-vercel@6.3.0.patch
```

With `patches/@sveltejs__adapter-vercel@6.3.0.patch`:

```diff
diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -661,7 +661,33 @@
 	let base = entry;
 	while (base !== (base = path.dirname(base)));

-	const traced = await nodeFileTrace([entry], { base });
+	// See: https://github.com/sveltejs/kit/issues/13764
+	const isOnVercel = entry.includes('/vercel/path0/');
+
+	const traced = await nodeFileTrace([entry], {
+		base,
+		ignore: (p) => {
+			if (isOnVercel) {
+				const isProjectFile = p.startsWith('vercel/path0/') || p.startsWith('/vercel/path0/');
+				if (!isProjectFile) return true;
+				if (p.includes('.vercel/cache/')) return true;
+				return false;
+			}
+			return false;
+		}
+	});

 	/** @type {Map<string, string[]>} */
 	const resolution_failures = new Map();
```

This reduces traced files from ~14,600 to ~700.

## Suggested Fix

The `create_function_bundle` function in `@sveltejs/adapter-vercel` should:

1. **Add a default `ignore` callback** to `nodeFileTrace` that excludes known system paths
2. **Scope tracing to project files** when running in the Vercel environment
3. **Optionally expose an `ignore` option** in the adapter config for users to customize
