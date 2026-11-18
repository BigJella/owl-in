import { useState, type FormEvent } from "react";

interface NamePageProps {
  initialName: string;
  error: string | null;
  busy: boolean;
  onSubmit: (name: string) => void;
}

export function NamePage({ initialName, error, busy, onSubmit }: NamePageProps) {
  const [name, setName] = useState(initialName);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  }

  return (
    <section className="lobby name-screen">
      <form className="name-card" onSubmit={submit}>
        <p className="eyebrow">KSU CARD CLUB</p>
        <h1>Who's playing?</h1>
        <p className="muted">
          Pick a name for the tables. You start with <strong className="gold">$10,000</strong> in Dining Dollars.
        </p>
        <input
          autoFocus
          maxLength={16}
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {error && <p className="form-error">{error}</p>}
        <button className="primary" disabled={busy || !name.trim()}>
          {busy ? "Connecting…" : "Enter"} <b>→</b>
        </button>
      </form>
    </section>
  );
}
