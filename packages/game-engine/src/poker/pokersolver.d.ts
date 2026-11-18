declare module "pokersolver" {
  export class Hand {
    /** Higher is better (1 = high card ... 9 = straight flush). */
    rank: number;
    name: string;
    descr: string;
    static solve(cards: string[], game?: string): Hand;
    static winners(hands: Hand[]): Hand[];
  }
  const pokersolver: { Hand: typeof Hand };
  export default pokersolver;
}
