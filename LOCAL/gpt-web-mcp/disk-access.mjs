import { lstat, opendir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const fail = (code, message) => Object.assign(Error(code + ': ' + message), { status: 400 })
const within = (root, target) => { const part = relative(root, target); return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)) }
const display = value => value.replaceAll('\\', '/')

export async function diskRoots() {
  if (process.platform !== 'win32') return ['/']
  const candidates = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index) + ':/')
  return (await Promise.all(candidates.map(async root => await stat(root).then(value => value.isDirectory(), () => false) ? root : null))).filter(Boolean)
}

// Full-drive paths remain ordinary filesystem paths, never devices, ADS or UNC RPC targets.
export function createDiskAccess({ protectedPaths = [] }) {
  const protectedRoots = protectedPaths.map(value => resolve(value))
  function validatePath(value) {
    if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f]/.test(value)) throw fail('PATH_DENIED', 'Use an absolute local file path')
    const path = display(value)
    if (process.platform === 'win32' ? !/^[a-z]:\//i.test(path) : !path.startsWith('/') || path.startsWith('//')) throw fail('PATH_DENIED', 'Use an absolute local drive path, for example C:/Users/name/file.txt')
    const root = parse(path).root, tail = path.slice(root.length).replace(/\/$/, '')
    const parts = tail ? tail.split('/') : []
    if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw fail('PATH_DENIED', 'Special paths and parent traversal are excluded')
    const absolute = resolve(path)
    if (protectedRoots.some(root => within(root, absolute))) throw fail('PATH_DENIED', 'OpenStarry internal service state is private')
    return { root, parts, absolute }
  }
  async function target(value) {
    const { root, parts, absolute } = validatePath(value)
    if (!(await stat(root)).isDirectory()) throw fail('PATH_DENIED', 'Drive is not available')
    let cursor = root
    for (let index = 0; index < parts.length; index++) {
      cursor = join(cursor, parts[index])
      try {
        const info = await lstat(cursor)
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw fail('PATH_DENIED', 'Linked files are excluded; use the original path')
        if (index < parts.length - 1 && !info.isDirectory()) throw fail('PATH_DENIED', 'Parent is not a directory')
        const resolved = await realpath(cursor)
        if (protectedRoots.some(root => within(root, resolved))) throw fail('PATH_DENIED', 'OpenStarry internal service state is private')
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return absolute
  }
  async function list({ path, offset = 0, limit = 200 } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw fail('INVALID_PAGE', 'Use offset 0–100000 and limit 1–500')
    if (!path) { const roots = await diskRoots(); return { scope: 'all-disks', roots, directories: roots, files: [], nextOffset: null } }
    const absolute = await target(path), files = [], directories = []
    let index = 0, nextOffset = null
    const directory = await opendir(absolute)
    for await (const item of directory) {
      const full = join(absolute, item.name)
      try { validatePath(full) } catch { continue }
      if (item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) continue
      if (index++ < offset) continue
      if (files.length + directories.length === limit) { nextOffset = offset + limit; break }
      ;(item.isDirectory() ? directories : files).push(display(full))
    }
    return { scope: 'all-disks', path: display(absolute), files, directories, nextOffset }
  }
  return { validatePath, target, list }
}
