import { useState, type FormEvent } from "react";

/** Public / Private: two square buttons, the chosen one solid gold. */
export function PrivacyToggle(props: { value: boolean | null; onChange: (isPublic: boolean) => void; disabled?: boolean }) {
  const { value, onChange, disabled = false } = props;
  return (
    <div className="segmented" role="radiogroup" aria-label="Career visibility">
      {[true, false].map((isPublic) => (
        <button
          key={String(isPublic)}
          type="button"
          role="radio"
          aria-checked={value === isPublic}
          className={value === isPublic ? "on" : ""}
          disabled={disabled}
          onClick={() => onChange(isPublic)}
        >
          {isPublic ? "Public" : "Private"}
        </button>
      ))}
    </div>
  );
}

interface NamePageProps {
  initialName: string;
  /** null: never chosen (default to public). */
  initialPublic: boolean | null;
  /** The name checked out; only the privacy choice is missing. Shows the name locked and makes the player pick. */
  nameLocked?: boolean;
  error: string | null;
  busy: boolean;
  onSubmit: (name: string, careerPublic: boolean) => void;
}

export function NamePage({ initialName, initialPublic, nameLocked = false, error, busy, onSubmit }: NamePageProps) {
  const [name, setName] = useState(initialName);
  const [careerPublic, setCareerPublic] = useState<boolean | null>(nameLocked ? null : (initialPublic ?? true));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() && careerPublic !== null) onSubmit(name.trim(), careerPublic);
  }

  return (
    <section className="lobby name-screen">
      <form className="name-card" onSubmit={submit}>
        <p className="eyebrow">KSU CARD CLUB</p>
        <h1>{nameLocked ? `Welcome back.` : "Who's playing?"}</h1>
        <p className="muted">
          {nameLocked ? (
            "One more thing: choose whether other players can see your career."
          ) : (
            <>
              Pick a name for the tables. You start with <strong className="gold">$10,000</strong> in Dining Dollars.
            </>
          )}
        </p>
        <input
          autoFocus={!nameLocked}
          disabled={nameLocked}
          aria-label="Your name"
          maxLength={16}
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="privacy-choice">
          <small>Career</small>
          <PrivacyToggle value={careerPublic} onChange={setCareerPublic} />
          <p className="muted">
            {careerPublic === null
              ? "Pick one to continue. You can change it later on your career page."
              : careerPublic
                ? "Anyone can open your career stats and hand history from the leaderboard."
                : "Only you can see your career. You'll still appear on the leaderboard."}
          </p>
        </div>
        {error && <p className="form-error">{error}</p>}
        <button className="primary" disabled={busy || !name.trim() || careerPublic === null}>
          {busy ? "Connecting…" : "Enter"} <b>→</b>
        </button>
      </form>
    </section>
  );
}
