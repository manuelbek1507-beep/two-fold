import { Link } from 'react-router-dom'
import { usePlayer } from '../lib/player'
import { Icon } from './Icon'

export function MiniPlayer() {
  const p = usePlayer()
  if (!p.current) return null
  const pct = p.duration ? Math.min(100, (p.position / p.duration) * 100) : 0
  return (
    <div className="mini-player" role="region" aria-label="Now playing">
      <div className="mini-bar" style={{ width: `${pct}%` }} />
      <Link to="/playlist" className="mini-info">
        <strong>{p.current.title}</strong><small>{p.buffering ? 'Loading…' : p.current.artist || 'Our Playlist'}</small>
      </Link>
      <button onClick={p.prev} aria-label="Previous"><Icon name="prev" /></button>
      <button className="main" onClick={p.toggle} aria-label={p.playing ? 'Pause' : 'Play'}><Icon name={p.playing ? 'pause' : 'play'} /></button>
      <button onClick={p.next} aria-label="Next"><Icon name="next" /></button>
    </div>
  )
}
