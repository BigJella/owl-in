/**
 * Where bot chips come from and go back to. Keeping it explicit means the total
 * number of chips in the system (bankrolls + bank + tables) never changes.
 */
export class HouseBank {
  constructor(public balance = 10_000_000) {}

  withdraw(amount: number): number {
    this.balance -= amount;
    return amount;
  }

  deposit(amount: number) {
    this.balance += amount;
  }
}
