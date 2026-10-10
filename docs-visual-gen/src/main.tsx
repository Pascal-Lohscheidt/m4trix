import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { markSceneReady } from './runtime/timeline';
import { sceneComponents } from './scenes';
import { findScene, sceneManifest } from './scenes/manifest';
import './lib/theme.css';
import './app.css';

function SingleScene({ id }: { id: string }) {
  const meta = findScene(id);
  const Scene = sceneComponents[id];

  // Parent effects run after child effects, so the scene's timeline is registered by now.
  useEffect(() => {
    document.fonts.ready.then(() => requestAnimationFrame(markSceneReady));
  }, []);

  if (!meta || !Scene) return <p style={{ padding: 32 }}>Unknown scene "{id}".</p>;
  return <Scene meta={meta} />;
}

function Gallery() {
  const previewWidth = Math.min(1100, window.innerWidth - 96);
  return (
    <main className="gallery">
      {sceneManifest.map((meta) => {
        const Scene = sceneComponents[meta.id];
        const scale = previewWidth / meta.width;
        return (
          <section key={meta.id}>
            <h2>
              <a href={`?scene=${meta.id}`}>{meta.title}</a>{' '}
              <span style={{ color: 'var(--ink-3)', fontWeight: 400 }}>
                {meta.output.kind} for docs/{meta.doc}
              </span>
            </h2>
            <div style={{ width: previewWidth, height: meta.height * scale }}>
              <div className="gallery-item" style={{ transform: `scale(${scale})` }}>
                <Scene meta={meta} />
              </div>
            </div>
          </section>
        );
      })}
    </main>
  );
}

const sceneId = new URLSearchParams(window.location.search).get('scene');
const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

createRoot(root).render(
  <StrictMode>{sceneId ? <SingleScene id={sceneId} /> : <Gallery />}</StrictMode>,
);
