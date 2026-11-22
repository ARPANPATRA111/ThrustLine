import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

export interface MapEntry {
  name: string;
  tagline: string;
  text: string;
  accent: string;
  src: string;
  srcSet: string;
  alt: string;
}

export default function MapShowcase({ maps }: { maps: MapEntry[] }) {
  const [index, setIndex] = useState(0);
  const [auto, setAuto] = useState(true);
  const reduce = useReducedMotion();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const map = maps[index];

  useEffect(() => {
    if (!auto || reduce) return;
    const id = setTimeout(() => setIndex((i) => (i + 1) % maps.length), 6000);
    return () => clearTimeout(id);
  }, [auto, index, reduce, maps.length]);

  const choose = (i: number) => {
    setAuto(false);
    setIndex(i);
  };

  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + maps.length) % maps.length;
    choose(next);
    tabs.current[next]?.focus();
  };

  return (
    <div className="maps" onMouseEnter={() => setAuto(false)}>
      <div className="map-tabs" role="tablist" aria-label="Maps" aria-orientation="vertical" onKeyDown={onKey}>
        {maps.map((m, i) => (
          <button
            key={m.name}
            ref={(el) => { tabs.current[i] = el; }}
            role="tab"
            id={`map-tab-${i}`}
            aria-selected={i === index}
            aria-controls="map-panel"
            tabIndex={i === index ? 0 : -1}
            className={i === index ? 'map-tab on' : 'map-tab'}
            style={{ ['--accent' as string]: m.accent }}
            onClick={() => choose(i)}
          >
            <span className="map-name">{m.name}</span>
            <span className="map-tagline">{m.tagline}</span>
            {i === index && auto && !reduce && <motion.span className="map-timer" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 6, ease: 'linear' }} />}
          </button>
        ))}
      </div>

      <div className="map-view" id="map-panel" role="tabpanel" aria-labelledby={`map-tab-${index}`}>
        <AnimatePresence initial={false} mode="popLayout">
          <motion.img
            key={map.name}
            src={map.src}
            srcSet={map.srcSet}
            sizes="(max-width: 900px) 100vw, 760px"
            alt={map.alt}
            width={1600}
            height={900}
            loading="lazy"
            decoding="async"
            initial={reduce ? false : { opacity: 0, scale: 1.04 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0 }}
            transition={{ duration: 0.6, ease: [0.2, 0.7, 0.2, 1] }}
          />
        </AnimatePresence>
        <div className="map-caption">
          <motion.div key={map.name} initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, delay: 0.1 }}>
            <span className="map-label" style={{ color: map.accent }}>{map.name}</span>
            <p>{map.text}</p>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
