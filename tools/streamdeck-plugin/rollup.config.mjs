// Builds src/plugin.ts → com.vtubepro.deck.sdPlugin/bin/plugin.js (one ESM file, Stream Deck's bundled Node 20 runs it).
import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

const sdPlugin = 'com.vtubepro.deck.sdPlugin';
export default {
  input: 'src/plugin.ts',
  output: { file: `${sdPlugin}/bin/plugin.js`, format: 'es', sourcemap: false },
  external: ['bufferutil', 'utf-8-validate'],
  plugins: [
    typescript({ tsconfig: './tsconfig.json', include: ['src/**/*.ts'], outDir: `${sdPlugin}/bin`, noEmitOnError: true }),
    nodeResolve({ browser: false, exportConditions: ['node'], preferBuiltins: true }),
    commonjs(),
    { name: 'emit-module-package-file', generateBundle() { this.emitFile({ fileName: 'package.json', source: '{ "type": "module" }', type: 'asset' }); } },
  ],
};
