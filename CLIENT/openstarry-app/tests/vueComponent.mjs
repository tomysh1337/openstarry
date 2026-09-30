import { readFile } from 'node:fs/promises'
import { compileScript, parse } from '@vue/compiler-sfc'
export async function componentUrl(url) {
  const { descriptor } = parse(await readFile(url, 'utf8'))
  let source = compileScript(descriptor, { id: url.pathname, inlineTemplate: true }).content
  for (const match of [...source.matchAll(/from (['"])([^'"]+)\1/g)]) {
    const spec = match[2], resolved = spec.endsWith('.vue') ? await componentUrl(new URL(spec, url)) : spec.startsWith('.') ? new URL(spec, url).href : import.meta.resolve(spec)
    source = source.replace(match[0], `from ${JSON.stringify(resolved)}`)
  }
  return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
}
