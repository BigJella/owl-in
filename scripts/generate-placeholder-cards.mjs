// Writes placeholder card + chip sprites to apps/client/public/assets.
// Replace them with real art by dropping files with the same names in place
// (or PNGs, then change CARD_EXT in apps/client/src/game/poker/assets.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "client", "public", "assets");
const cardsDir = join(root, "cards");
const chipsDir = join(root, "chips");
mkdirSync(cardsDir, { recursive: true });
mkdirSync(chipsDir, { recursive: true });

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = [
  { code: "S", symbol: "♠", color: "#1d2021" },
  { code: "H", symbol: "♥", color: "#c8333c" },
  { code: "D", symbol: "♦", color: "#c8333c" },
  { code: "C", symbol: "♣", color: "#1d2021" },
];
const W = 140;
const H = 200;
const font = "font-family='Georgia, serif'";

for (const suit of SUITS) {
  for (const rank of RANKS) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="12" fill="#fdfbf4" stroke="#cfc8b3" stroke-width="2"/>
  <text x="12" y="36" ${font} font-size="30" font-weight="700" fill="${suit.color}">${rank}</text>
  <text x="14" y="62" ${font} font-size="24" fill="${suit.color}">${suit.symbol}</text>
  <text x="${W / 2}" y="${H / 2 + 26}" ${font} font-size="76" text-anchor="middle" fill="${suit.color}">${suit.symbol}</text>
  <g transform="rotate(180 ${W / 2} ${H / 2})">
    <text x="12" y="36" ${font} font-size="30" font-weight="700" fill="${suit.color}">${rank}</text>
  </g>
</svg>
`;
    writeFileSync(join(cardsDir, `${rank}${suit.code}.svg`), svg);
  }
}

writeFileSync(
  join(cardsDir, "back.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <pattern id="p" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="14" height="14" fill="#5b2a86"/><rect width="7" height="14" fill="#6d36a0"/>
    </pattern>
  </defs>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="12" fill="#fdfbf4" stroke="#cfc8b3" stroke-width="2"/>
  <rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="8" fill="url(#p)"/>
  <circle cx="${W / 2}" cy="${H / 2}" r="26" fill="#e5b85b"/>
  <text x="${W / 2}" y="${H / 2 + 11}" ${font} font-size="32" font-weight="700" text-anchor="middle" fill="#2a1840">O</text>
</svg>
`,
);

writeFileSync(
  join(chipsDir, "chip.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="30" fill="#e5b85b" stroke="#8c6a24" stroke-width="2"/>
  <g stroke="#fff" stroke-width="7" stroke-dasharray="9 14.6" fill="none"><circle cx="32" cy="32" r="25"/></g>
  <circle cx="32" cy="32" r="17" fill="#d2a447" stroke="#8c6a24" stroke-width="1.5"/>
</svg>
`,
);

console.log(`Wrote ${RANKS.length * SUITS.length + 1} card sprites and 1 chip to ${root}`);
