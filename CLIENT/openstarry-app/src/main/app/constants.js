export const isMac = process.platform === 'darwin'
export const isWin = process.platform === 'win32'

// Windows 11 starts at build 22000. Windows 10 reports builds in the 10.0.19xxx range.
export const isWindows11 = isWin && (() => {
  const version = process.getSystemVersion?.() || ''
  const build = Number(version.split('.')[2])
  return Number.isFinite(build) && build >= 22000
})()
