// Ways minbox gets the person's attention: the tab title and favicon count,
// browser notifications and a two-tone chime.

let audio: AudioContext | null = null

/** "Ding-dong": two soft sine tones, made on the fly (no asset). */
export function dingDong() {
  try {
    audio ??= new AudioContext()
    const ctx = audio
    const tone = (freq: number, at: number) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = freq
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at)
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.55)
      o.connect(g).connect(ctx.destination)
      o.start(ctx.currentTime + at)
      o.stop(ctx.currentTime + at + 0.6)
    }
    tone(880, 0)
    tone(660, 0.28)
  } catch {
    /* no audio */
  }
}

let baseIcon: HTMLImageElement | null = null

/** Draws the favicon with a count badge (0 clears it). */
export function setFaviconCount(n: number) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) return
  if (!link.dataset.base) link.dataset.base = link.href
  if (n <= 0) {
    link.href = link.dataset.base
    return
  }
  const draw = () => {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')
    if (!g || !baseIcon) return
    g.drawImage(baseIcon, 0, 0, 64, 64)
    g.fillStyle = '#e5664a'
    g.beginPath()
    g.arc(46, 18, 18, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = '#fff'
    g.font = 'bold 26px system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(n > 9 ? '9+' : String(n), 46, 19)
    link.href = c.toDataURL('image/png')
  }
  if (baseIcon?.complete) draw()
  else {
    baseIcon = new Image()
    baseIcon.onload = draw
    baseIcon.src = link.dataset.base
  }
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return 'Notification' in window ? Notification.permission : 'unsupported'
}

export async function requestNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (!('Notification' in window)) return 'unsupported'
  return Notification.requestPermission()
}

export function notify(title: string, body: string, onClick?: () => void) {
  if (notificationPermission() !== 'granted') return
  const n = new Notification(title, { body, tag: 'minbox', icon: '/favicon.svg' })
  n.onclick = () => {
    window.focus()
    onClick?.()
    n.close()
  }
}
