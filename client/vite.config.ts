import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
	build: {
		lib: {
			entry: resolve(__dirname, 'src/index.ts'),
			formats: ['es'],
			name: 'index',
			fileName: 'index'
		},
		outDir: 'lib'
	},
	plugins: [
		dts({
			insertTypesEntry: true
		})
	]
});
