// Tiny DOM helpers for the HUD. Values are cached so the DOM is only touched
// when something actually changes.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  parent?: HTMLElement,
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (html !== undefined) node.innerHTML = html
  if (parent) parent.appendChild(node)
  return node
}

const textCache = new WeakMap<HTMLElement, string>()
export function setText(node: HTMLElement, text: string): void {
  if (textCache.get(node) === text) return
  textCache.set(node, text)
  node.textContent = text
}

const styleCache = new WeakMap<HTMLElement, Map<string, string>>()
export function setStyle(node: HTMLElement, prop: string, value: string): void {
  let map = styleCache.get(node)
  if (!map) {
    map = new Map()
    styleCache.set(node, map)
  }
  if (map.get(prop) === value) return
  map.set(prop, value)
  node.style.setProperty(prop, value)
}

export function show(node: HTMLElement, visible: boolean): void {
  setStyle(node, 'display', visible ? '' : 'none')
}

export interface Bar {
  root: HTMLDivElement
  fill: HTMLDivElement
  ghost: HTMLDivElement
  label: HTMLDivElement
}

export function bar(parent: HTMLElement, color: string, heightPx: number, withGhost = true): Bar {
  const root = el('div', 'bar', parent)
  root.style.height = `${heightPx}px`
  const ghost = el('div', 'ghost', root)
  if (!withGhost) ghost.style.display = 'none'
  const fill = el('div', 'fill', root)
  fill.style.background = color
  const label = el('div', 'label', root)
  return { root, fill, ghost, label }
}

export function setBar(b: Bar, frac: number, text?: string): void {
  const f = Math.max(0, Math.min(1, frac))
  setStyle(b.fill, 'transform', `scaleX(${f.toFixed(4)})`)
  setStyle(b.ghost, 'transform', `scaleX(${f.toFixed(4)})`)
  if (text !== undefined) setText(b.label, text)
}

export function fmtTime(s: number): string {
  if (s >= 10) return `${Math.ceil(s)}`
  if (s >= 1) return `${Math.ceil(s)}`
  return s.toFixed(1)
}
