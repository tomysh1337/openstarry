const paths = {
  files: 'M8 3H4v14h4M8 7h12v14H8zM12 11h5M12 15h5',
  editor: 'm8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18',
  review: 'M8 3H4v18h16V7l-4-4H8m8 0v5h4M8 12h8m-8 5h8m-4-3v6',
  output: 'M3 5h18v14H3zM6 9l3 3-3 3m6 0h5',
  agent: 'M12 2v4m0 12v4M2 12h4m12 0h4M5 5l3 3m8 8 3 3M5 19l3-3m8-8 3-3M12 7l2 3 3 2-3 2-2 3-2-3-3-2 3-2z',
  chat: 'M4 4h16v12H9l-5 4V4zM8 8h8M8 12h5',
  plus: 'M12 5v14M5 12h14', close: 'm6 6 12 12M6 18 18 6',
  history: 'M3 10a9 9 0 1 1 1 7M3 4v6h6m3-3v6l4 2',
  attach: 'm9 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9m-6 11 7-7',
  arrow: 'M12 19V5m-6 6 6-6 6 6', stop: 'M6 6h12v12H6z',
  folder: 'M3 5h7l2 3h9v12H3z', save: 'M4 3h13l3 3v15H4zM8 3v6h8V3M8 21v-7h8v7',
  search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0m-2 5 7 7',
  chevron: 'm9 6 6 6-6 6', check: 'm5 12 4 4 10-10',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  theme: 'M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z',
}
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.5'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name] || paths.editor); svg.append(path); return svg
}
