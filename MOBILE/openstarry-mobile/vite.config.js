import { defineConfig } from 'vite'
export default defineConfig({
  server: { fs: { allow: ['.', '../../SHARED/workbench'] }, watch: { ignored: ['**/android/**'] } }, build: { assetsInlineLimit: 0 },
  plugins: [{ name: 'offline-asset-manifest', generateBundle(_options, bundle) {
    this.emitFile({ type: 'asset', fileName: 'asset-manifest.json', source: JSON.stringify(Object.keys(bundle).filter(name => name.startsWith('assets/')).map(name => '/' + name)) })
  } }]
})
