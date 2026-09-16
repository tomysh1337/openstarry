import { pageRegistry } from '../router/pageRegistry'

let activeAnimations = []
export function animateNavigation(root, to, from) {
  activeAnimations.forEach(animation => animation.cancel())
  activeAnimations = []
  if (!root || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const index = path => pageRegistry.findIndex(page => page.path === path)
  const direction = index(to) >= index(from) ? 1 : -1
  // Keep the navigation and content usable while the destination settles.
  const content = root.querySelector('.main-area')
  if (content) activeAnimations.push(content.animate([
    { opacity: .64, transform: `translateY(${direction * 12}px)` },
    { opacity: 1, transform: 'translateY(0)' }
  ], { duration: 280, easing: 'cubic-bezier(.16, 1, .3, 1)' }))
  const selected = root.querySelector('.el-menu-item.is-active')
  const previous = [...root.querySelectorAll('.el-menu-item')].find(item => item.getAttribute('data-route') === from)
  if (selected && previous) {
    const offset = previous.getBoundingClientRect().top - selected.getBoundingClientRect().top
    activeAnimations.push(selected.animate([
      { transform: `translateY(${offset}px)`, opacity: .5 },
      { transform: 'translateY(0)', opacity: 1 }
    ], { pseudoElement: '::before', duration: 360, easing: 'cubic-bezier(.16, 1, .3, 1)' }))
  }
}
