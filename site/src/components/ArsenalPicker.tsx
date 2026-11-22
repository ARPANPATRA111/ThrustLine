import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

export interface Gear {
  name: string;
  role: string;
  text: string;
  icon: { src: string; width: number; height: number };
  stats: { label: string; value: string; pct: number }[];
}

export default function ArsenalPicker({ groups }: { groups: { label: string; items: Gear[] }[] }) {
  const all = groups.flatMap((g) => g.items);
  const [active, setActive] = useState(all[1]?.name ?? all[0].name);
  const reduce = useReducedMotion();
  const gear = all.find((g) => g.name === active) ?? all[0];

  return (
    <div className="arsenal">
      <div className="gear-list">
        {groups.map((group) => (
          <div key={group.label} className="gear-group">
            <h3 className="gear-group-label">{group.label}</h3>
            <div className="gear-grid">
              {group.items.map((g) => (
                <button
                  key={g.name}
                  type="button"
                  className={g.name === active ? 'gear on' : 'gear'}
                  aria-pressed={g.name === active}
                  onClick={() => setActive(g.name)}
                >
                  <span className="gear-icon"><img src={g.icon.src} alt="" width={g.icon.width} height={g.icon.height} loading="lazy" decoding="async" /></span>
                  <span className="gear-name">{g.name}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="gear-panel" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={gear.name}
            initial={reduce ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -10 }}
            transition={{ duration: 0.28, ease: [0.2, 0.7, 0.2, 1] }}
          >
            <div className="gear-hero">
              <img src={gear.icon.src} alt={`${gear.name} sprite from the game`} width={gear.icon.width} height={gear.icon.height} />
            </div>
            <span className="gear-role">{gear.role}</span>
            <h3 className="gear-title">{gear.name}</h3>
            <p className="gear-text">{gear.text}</p>
            <dl className="gear-stats">
              {gear.stats.map((s, i) => (
                <div key={s.label} className="gear-stat">
                  <dt>{s.label}</dt>
                  <dd>{s.value}</dd>
                  <span className="gear-bar">
                    <motion.span
                      initial={reduce ? false : { width: 0 }}
                      animate={{ width: `${s.pct}%` }}
                      transition={{ duration: 0.7, delay: 0.08 * i, ease: [0.2, 0.7, 0.2, 1] }}
                    />
                  </span>
                </div>
              ))}
            </dl>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
