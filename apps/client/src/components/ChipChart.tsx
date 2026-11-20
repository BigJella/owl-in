import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { STARTING_BANKROLL, formatDD, type ChipPoint } from "@owl-in/shared";

/*
 * Total Dining Dollars after every hand. One series (so no series legend: the title names it), drawn as a 2px gold
 * line. Each hand is a node; the game is told apart by SHAPE + FILL, not a second hue (KSU gold is too light to pair
 * with another categorical colour, and the site is black & gold): poker = solid square, blackjack = hollow diamond.
 * Hover / arrow keys move a crosshair that snaps to the nearest hand; the tooltip leads with the value.
 */

const GOLD = "#ffb81c";
const SURFACE = "#141414";
const GRID = "#2e2e2e";
const MUTED = "#8a8a8a";
const M = { top: 18, right: 72, bottom: 30, left: 64 };
/** Below this many pixels per hand the nodes would overlap: draw the line only (hover still snaps to every hand). */
const MIN_NODE_SPACING = 6;

type Range = "50" | "200" | "all";
const RANGES: { key: Range; label: string }[] = [
  { key: "50", label: "Last 50" },
  { key: "200", label: "Last 200" },
  { key: "all", label: "All" },
];

/** Round tick step: 1, 2, 2.5 or 5 × 10^n, aiming for about `count` ticks. */
function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

function ticks(min: number, max: number, count: number): number[] {
  const step = niceStep(max - min || 1, count);
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/** "$10K" / "$10.5K" on an axis that reaches 10,000 with round steps; full "$9,750" otherwise. */
function yLabel(v: number, step: number): string {
  if (Math.abs(v) >= 10_000 && step >= 500) return `$${Number((v / 1000).toFixed(step >= 1000 ? 0 : 1))}K`;
  return formatDD(v);
}

const signed = (n: number) => (n > 0 ? `+${formatDD(n)}` : n < 0 ? `-${formatDD(-n)}` : formatDD(0));

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function Marker({ game, x, y, size }: { game: ChipPoint["game"]; x: number; y: number; size: number }) {
  const h = size / 2;
  return game === "poker" ? (
    <rect x={x - h} y={y - h} width={size} height={size} fill={GOLD} stroke={SURFACE} strokeWidth={2} />
  ) : (
    <polygon
      points={`${x},${y - h - 1} ${x + h + 1},${y} ${x},${y + h + 1} ${x - h - 1},${y}`}
      fill={SURFACE}
      stroke={GOLD}
      strokeWidth={2}
    />
  );
}

export function ChipChart({ points }: { points: ChipPoint[] }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [range, setRange] = useState<Range>("all");
  const [active, setActive] = useState<number | null>(null);
  const height = width < 560 ? 210 : 260;

  const visible = useMemo(
    () => (range === "all" ? points : points.slice(-Number(range))),
    [points, range],
  );
  // The line starts from the total just before the first visible hand (the starting bankroll for a full history).
  const before = points.length > visible.length ? points[points.length - visible.length - 1]!.total : STARTING_BANKROLL;
  const firstHand = visible[0] ? visible[0].hand - 1 : 0;
  const series = useMemo(() => [{ hand: firstHand, total: before }, ...visible], [visible, before, firstHand]);

  useEffect(() => setActive(null), [range, points.length]);

  const games = new Set(points.map((p) => p.game));
  const last = points.at(-1);
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;

  const totals = series.map((p) => p.total);
  const lo = Math.min(...totals, STARTING_BANKROLL);
  const hi = Math.max(...totals, STARTING_BANKROLL);
  const pad = Math.max((hi - lo) * 0.08, 50);
  const yTicks = ticks(lo - pad, hi + pad, height < 240 ? 3 : 4);
  const yMin = Math.min(lo - pad, yTicks[0] ?? lo);
  const yMax = Math.max(hi + pad, yTicks.at(-1) ?? hi);
  const yStep = yTicks.length > 1 ? yTicks[1]! - yTicks[0]! : 1000;
  const xMax = series.at(-1)!.hand;
  const xSpan = Math.max(1, xMax - firstHand);
  const x = (hand: number) => M.left + ((hand - firstHand) / xSpan) * plotW;
  const y = (total: number) => M.top + (1 - (total - yMin) / (yMax - yMin)) * plotH;
  const xTicks = ticks(firstHand, xMax, Math.max(2, Math.floor(plotW / 110))).filter((t) => Number.isInteger(t));

  const path = series.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.hand).toFixed(1)},${y(p.total).toFixed(1)}`).join("");
  const showNodes = plotW / Math.max(1, visible.length) >= MIN_NODE_SPACING;
  const activePoint = active === null ? null : (visible[active] ?? null);

  function onPointer(event: PointerEvent<SVGRectElement>) {
    if (visible.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const hand = firstHand + ((event.clientX - rect.left) / rect.width) * xSpan;
    const index = Math.min(visible.length - 1, Math.max(0, Math.round(hand - visible[0]!.hand)));
    setActive(index);
  }

  function onKey(event: KeyboardEvent<SVGSVGElement>) {
    if (visible.length === 0) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    setActive((current) => {
      const from = current ?? visible.length - 1;
      return Math.min(visible.length - 1, Math.max(0, step === Infinity ? visible.length - 1 : step === -Infinity ? 0 : from + step));
    });
  }

  const summary = last
    ? `Dining Dollars over ${points.length} hands, from ${formatDD(STARTING_BANKROLL)} to ${formatDD(last.total)}.`
    : "No hands played yet.";

  return (
    <section className="chip-chart" aria-label="Dining Dollars over time">
      <header className="chip-chart-head">
        <div>
          <h2>Dining Dollars over time</h2>
          <p className="muted">Total after every hand. Start {formatDD(STARTING_BANKROLL)}.</p>
        </div>
        <div className="chip-chart-tools">
          {games.size > 0 && (
            <ul className="chip-legend" aria-label="Legend">
              {games.has("poker") && (
                <li>
                  <svg width="12" height="12" aria-hidden="true">
                    <Marker game="poker" x={6} y={6} size={8} />
                  </svg>
                  Poker hand
                </li>
              )}
              {games.has("blackjack") && (
                <li>
                  <svg width="14" height="14" aria-hidden="true">
                    <Marker game="blackjack" x={7} y={7} size={7} />
                  </svg>
                  Blackjack round
                </li>
              )}
            </ul>
          )}
          {points.length > 50 && (
            <div className="segmented chip-range" role="radiogroup" aria-label="Range">
              {RANGES.map((r) => (
                <button key={r.key} type="button" role="radio" aria-checked={range === r.key} className={range === r.key ? "on" : ""} data-hb={`chart:range:${r.key}`} onClick={() => setRange(r.key)}>
                  {r.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      <div className="chip-plot" ref={wrapRef} style={{ height }}>
        {points.length === 0 ? (
          <p className="muted chip-empty">No hands yet. Play a hand of poker or blackjack and it shows up here.</p>
        ) : (
          width > 0 && (
            <>
              <svg
                width={width}
                height={height}
                role="img"
                aria-label={summary}
                tabIndex={0}
                data-hb="chart"
                data-hb-adjust="keys"
                onKeyDown={onKey}
                onBlur={() => setActive(null)}
              >
                {/* Recessive grid: hairline, solid. */}
                {yTicks.map((t) => (
                  <g key={t}>
                    <line x1={M.left} x2={M.left + plotW} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
                    <text x={M.left - 10} y={y(t)} dy="0.35em" textAnchor="end" className="chip-axis">
                      {yLabel(t, yStep)}
                    </text>
                  </g>
                ))}
                {xTicks.map((t) => (
                  <text key={t} x={x(t)} y={height - 8} textAnchor="middle" className="chip-axis">
                    {t === 0 ? "Start" : t}
                  </text>
                ))}
                <text x={M.left + plotW} y={height - 8} dx={12} className="chip-axis" textAnchor="start">
                  hands
                </text>
                {/* Where every player started. */}
                <line
                  x1={M.left}
                  x2={M.left + plotW}
                  y1={y(STARTING_BANKROLL)}
                  y2={y(STARTING_BANKROLL)}
                  stroke={MUTED}
                  strokeWidth={1}
                  opacity={0.6}
                />
                <path d={path} fill="none" stroke={GOLD} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {showNodes && visible.map((p) => <Marker key={p.hand} game={p.game} x={x(p.hand)} y={y(p.total)} size={8} />)}
                {/* Endpoint label: the current total. */}
                {last && visible.at(-1) === last && (
                  <text x={x(last.hand) + 10} y={y(last.total)} dy="0.35em" className="chip-end">
                    {formatDD(last.total)}
                  </text>
                )}
                {activePoint && (
                  <g pointerEvents="none">
                    <line x1={x(activePoint.hand)} x2={x(activePoint.hand)} y1={M.top} y2={M.top + plotH} stroke={MUTED} strokeWidth={1} />
                    <Marker game={activePoint.game} x={x(activePoint.hand)} y={y(activePoint.total)} size={12} />
                  </g>
                )}
                {/* Hit area: the whole plot, so the pointer only has to be near a hand. */}
                <rect
                  x={M.left}
                  y={M.top}
                  width={plotW}
                  height={plotH}
                  fill="transparent"
                  onPointerMove={onPointer}
                  onPointerDown={onPointer}
                  onPointerLeave={() => setActive(null)}
                />
              </svg>
              {activePoint && (
                <div
                  className="chip-tooltip"
                  role="status"
                  style={{
                    left: Math.min(Math.max(x(activePoint.hand), 90), width - 90),
                    top: Math.max(4, y(activePoint.total) - 78),
                  }}
                >
                  <strong>{formatDD(activePoint.total)}</strong>
                  <span>
                    Hand {activePoint.hand} · {activePoint.game === "poker" ? "Poker" : "Blackjack"}
                  </span>
                  <span>
                    <b className={activePoint.net > 0 ? "gold" : activePoint.net < 0 ? "loss" : ""}>{signed(activePoint.net)}</b> ·{" "}
                    {new Date(activePoint.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </span>
                </div>
              )}
            </>
          )
        )}
      </div>
    </section>
  );
}
