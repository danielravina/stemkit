import { registerHooks } from 'node:module'

const srcRoot = new URL('../../src/', import.meta.url).href

// src/ uses extensionless relative imports (bundler resolution); node needs the .ts spelled out.
// With stubEnv, './env' is replaced by a data-URL module with that source (it touches Electron).
// Deregister the returned hooks once the dynamic imports are done.
export function registerTsHooks({ stubEnv } = {}) {
  return registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.startsWith(srcRoot) && specifier.startsWith('.')) {
        if (stubEnv !== undefined && specifier === './env') {
          return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(stubEnv)}` }
        }
        if (!/\.\w+$/.test(specifier)) {
          return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href }
        }
      }
      return next(specifier, context)
    }
  })
}
