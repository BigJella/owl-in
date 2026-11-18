import { useEffect, useRef } from "react";
import { blackjackStore } from "../../networking/blackjackStore";
import { loadPokerTextures } from "../poker/assets";
import { getPixiApp } from "../poker/pixiApp";
import { BlackjackRenderer } from "./BlackjackRenderer";

/** The Pixi canvas for a blackjack table. Borrows the shared Pixi app (never create a second one). */
export function BlackjackScene({ selectedSpot, onSpotClick }: { selectedSpot: number | null; onSpotClick: (spot: number) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<BlackjackRenderer | null>(null);
  const clickRef = useRef(onSpotClick);
  clickRef.current = onSpotClick;
  const selectedRef = useRef(selectedSpot);
  selectedRef.current = selectedSpot;

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    const fonts = Promise.all([
      document.fonts.load('600 14px "Oswald"'),
      document.fonts.load('700 14px "Oswald"'),
    ]).catch(() => undefined);
    Promise.all([getPixiApp(), loadPokerTextures(), fonts]).then(([app, textures]) => {
      const el = host.current;
      if (cancelled || !el) return;
      el.appendChild(app.canvas);
      app.resizeTo = el;
      app.resize();
      app.ticker.start();

      const r = new BlackjackRenderer(app, textures, (spot) => clickRef.current(spot));
      renderer.current = r;
      r.setSelected(selectedRef.current);
      const latest = blackjackStore.latest();
      if (latest) r.push(latest);
      const unsubscribe = blackjackStore.subscribe((received) => r.push(received));

      cleanup = () => {
        unsubscribe();
        renderer.current = null;
        r.destroy();
        app.ticker.stop();
        app.canvas.remove();
      };
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    renderer.current?.setSelected(selectedSpot);
  }, [selectedSpot]);

  return <div ref={host} className="poker-canvas" />;
}
