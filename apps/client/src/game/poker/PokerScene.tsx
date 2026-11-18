import { useEffect, useRef } from "react";
import { pokerStore } from "../../networking/pokerStore";
import { loadPokerTextures } from "./assets";
import { getPixiApp } from "./pixiApp";
import { PokerRenderer } from "./PokerRenderer";

/** The Pixi canvas for a poker table. Borrows the shared Pixi app and sizes it to this box. */
export function PokerScene() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    Promise.all([getPixiApp(), loadPokerTextures()]).then(([app, textures]) => {
      const el = host.current;
      if (cancelled || !el) return;
      el.appendChild(app.canvas);
      app.resizeTo = el;
      app.resize();
      app.ticker.start();

      const renderer = new PokerRenderer(app, textures);
      const latest = pokerStore.latest();
      if (latest) renderer.push(latest);
      const unsubscribe = pokerStore.subscribe((received) => renderer.push(received));

      cleanup = () => {
        unsubscribe();
        renderer.destroy();
        app.ticker.stop();
        app.canvas.remove();
      };
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return <div ref={host} className="poker-canvas" />;
}
