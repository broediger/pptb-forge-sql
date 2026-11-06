import { defineConfig } from 'vite';

/**
 * Builds dist/headless.js, the Node entry the PPTB MCP server imports to run
 * queries without opening the tool window. CommonJS, since package.json has
 * no "type": "module". Runs after the main build, so it must not empty dist/.
 */
export default defineConfig({
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        target: 'node18',
        minify: false,
        lib: {
            entry: 'src/headless.ts',
            formats: ['cjs'],
            fileName: () => 'headless.js',
        },
    },
});
