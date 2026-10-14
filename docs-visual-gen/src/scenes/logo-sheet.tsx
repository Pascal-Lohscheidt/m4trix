import type { CSSProperties } from 'react';
import { Frame } from '../lib';
import { AppIcon, MARKS } from '../lib/brand/marks';
import type { SceneProps } from './manifest';

const LIGHT = { bg: '#f4f5f7', ink: '#16161a', sub: '#6b6b76' };
const DARK = { bg: '#0b0b0e', ink: '#ececf0', sub: '#8a8a96' };
const VIOLET = { bg: '#6d28d9', ink: '#ffffff' };

const tile = (bg: string, extra?: CSSProperties): CSSProperties => ({
  background: bg,
  borderRadius: 20,
  display: 'grid',
  placeItems: 'center',
  boxShadow: '0 0 0 1px rgba(20,20,30,.08)',
  ...extra,
});

/** Brand: every logo concept in light, dark and on the accent, at real sizes, with a lockup. */
export function LogoSheet({ meta, theme }: SceneProps) {
  return (
    <Frame width={meta.width} height={meta.height} theme={theme}>
      <div style={{ position: 'absolute', inset: 48, display: 'grid', gap: 28 }}>
        {MARKS.map(({ id, name, Mark }) => (
          <div
            key={id}
            style={{
              display: 'grid',
              gridTemplateColumns: '170px 200px 200px 200px 300px 1fr',
              gap: 20,
              alignItems: 'center',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, color: LIGHT.ink }}>{name}</div>
            <div style={tile(LIGHT.bg, { height: 200, color: LIGHT.ink })}>
              <Mark size={128} weight={8} />
            </div>
            <div style={tile(DARK.bg, { height: 200, color: DARK.ink })}>
              <Mark size={128} weight={8} />
            </div>
            <div style={tile(VIOLET.bg, { height: 200, color: VIOLET.ink })}>
              <Mark size={128} weight={8} />
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              {[LIGHT, DARK].map((c) => (
                <div
                  key={c.bg}
                  style={tile(c.bg, {
                    height: 88,
                    color: c.ink,
                    display: 'flex',
                    gap: 22,
                    justifyContent: 'center',
                    alignItems: 'center',
                  })}
                >
                  <Mark size={48} weight={8} />
                  <Mark size={32} weight={8} />
                  <Mark size={20} weight={9} />
                  <Mark size={16} weight={10} />
                </div>
              ))}
            </div>
            <div
              style={tile(LIGHT.bg, {
                height: 200,
                color: LIGHT.ink,
                justifyItems: 'start',
                paddingLeft: 36,
              })}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
                <Mark size={44} weight={8} />
                <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: 0.5 }}>m4trix</span>
              </span>
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 28, alignItems: 'center' }}>
          <div style={{ width: 170, fontSize: 15, fontWeight: 600, color: LIGHT.ink }}>
            App icon
          </div>
          <AppIcon size={160} />
          <AppIcon size={160} tile="#ffffff" ink="#0b0b0e" />
          <AppIcon size={160} tile="#6d28d9" />
          <AppIcon size={64} weight={7} />
          <AppIcon size={32} weight={8} />
          <AppIcon size={16} weight={9} />
        </div>
      </div>
    </Frame>
  );
}
