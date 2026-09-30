export const safetyLevels = [
  { value: 'ask', label: '请示批准', description: '文件写入和容器执行均需本机确认。' },
  { value: 'auto', label: '帮我批准', description: '新文件和禁网容器自动执行；覆盖文件、容器联网需确认。' },
  { value: 'full', label: '完全访问权限', description: '文件直接写入并保留版本检查；允许容器联网。作用于本应用全部 MCP 任务。' },
]
