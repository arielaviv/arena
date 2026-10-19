// Online smoke test: N players queue, get matched, join the room, move, read snapshots.
// Usage: node scripts/online-smoke.mjs [baseUrl=http://127.0.0.1:8787] [players=2]
const base = process.argv[2] ?? 'http://127.0.0.1:8787'
const count = Number(process.argv[3] ?? 2)
const ws = base.replace(/^http/, 'ws')
const classes = ['cindrake', 'tidehorn', 'venomaw', 'petalyn']

function queue(i) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`${ws}/queue?class=${classes[i % 4]}&name=P${i}&difficulty=0.3`)
    const t0 = Date.now()
    const timer = setTimeout(() => reject(new Error('queue timeout')), 15000)
    sock.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'match') {
        clearTimeout(timer)
        resolve({ ...msg, waited: Date.now() - t0 })
      }
    })
    sock.addEventListener('error', () => reject(new Error('queue socket error')))
  })
}

function play(match, i) {
  return new Promise((resolve) => {
    const sock = new WebSocket(`${ws}/room/${match.room}?token=${match.token}`)
    let snaps = 0
    let first = null
    let last = null
    let seq = 0
    let welcome = null
    let bytes = 0
    const pump = setInterval(() => {
      if (sock.readyState !== 1) return
      const cmds = []
      for (let k = 0; k < 2; k++) cmds.push({ seq: ++seq, moveX: 0, moveZ: 1, yaw: i % 2 ? Math.PI : 0, pitch: 0, buttons: 0 })
      sock.send(JSON.stringify({ type: 'inputs', cmds }))
    }, 33)
    sock.addEventListener('message', (ev) => {
      bytes += ev.data.length
      const msg = JSON.parse(ev.data)
      if (msg.type === 'welcome') {
        welcome = msg
        sock.send(JSON.stringify({ type: 'ready' }))
      }
      if (msg.type === 'snap') {
        snaps++
        const me = msg.snap.fighters.find((f) => f.id === match.you)
        if (!first && msg.snap.phase === 'live') first = { x: me.x, z: me.z, tick: msg.snap.tick }
        if (first) last = { x: me.x, z: me.z, tick: msg.snap.tick, phase: msg.snap.phase, lastSeq: me.lastSeq }
      }
    })
    setTimeout(() => {
      clearInterval(pump)
      sock.close()
      resolve({ you: match.you, welcome: welcome?.you, snaps, first, last, kbPerSec: (bytes / 1024 / 9).toFixed(1) })
    }, 9000)
  })
}

const matches = await Promise.all(Array.from({ length: count }, (_, i) => queue(i)))
console.log('matched:', matches.map((m) => ({ room: m.room.slice(0, 8), you: m.you, theme: m.theme, waitedMs: m.waited })))
const results = await Promise.all(matches.map((m, i) => play(m, i)))
for (const r of results) {
  const moved = r.first && r.last ? Math.hypot(r.last.x - r.first.x, r.last.z - r.first.z).toFixed(1) : 'n/a'
  console.log(`fighter ${r.you}: welcome=${r.welcome} snaps=${r.snaps} moved=${moved}m lastSeq=${r.last?.lastSeq} phase=${r.last?.phase} ${r.kbPerSec} KB/s`)
}
process.exit(0)
