import { Application } from "pixi.js";

let appPromise: Promise<Application> | null = null;

/**
 * One Pixi application (and one WebGL context) for the whole session.
 * Table pages borrow its canvas instead of creating/destroying their own, which
 * avoids leaking GPU contexts every time you leave and join a table.
 */
export function getPixiApp(): Promise<Application> {
  appPromise ??= (async () => {
    const app = new Application();
    await app.init({
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      preference: "webgl",
    });
    app.ticker.stop(); // started while a table is on screen
    return app;
  })();
  return appPromise;
}
