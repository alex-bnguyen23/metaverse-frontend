import { Link } from "react-router";
import { useState } from "react";
import { defaultAppearance, type Appearance } from "../utils/appearance";
import World from "../components/World";
// Choice indexes match Appearance values and the color palettes used by the model.
// `as const` preserves exact keys so appearance[key] can be checked by TypeScript.
const options = [
  { key: "shirt", label: "Shirt color", choices: ["Red", "Blue", "Green"] },
  { key: "pants", label: "Pants color", choices: ["Black", "Blue"] },
  { key: "hairstyle", label: "Hairstyle", choices: ["Short", "Ponytail"] },
  { key: "glasses", label: "Glasses", choices: ["Off", "On"] },
] as const;
// App owns the state; this page reports selections and passes them to the live preview.
export default function DressPage({
  appearance,
  onChange,
}: {
  appearance: Appearance;
  onChange: (appearance: Appearance) => void;
}) {
  const [name, setName] = useState(() => {
    try {
      return sessionStorage.getItem("osaka-player-name") || "Player";
    } catch {
      return "Player";
    }
  });
  return (
    <>
      <main className="dress-page">
        <section className="dress-options">
          <p className="eyebrow">OSAKA / YOUR ADVENTURE</p>
          <h1>Dressing room</h1>
          <p>Choose your look before exploring the castle.</p>
          <label className="my-3 block">
            Player name
            <input
              className="mt-1 block w-full rounded border border-green-900/20 bg-white p-2"
              value={name}
              maxLength={24}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="dress-option-groups">
            {/* Generate groups from the option definitions to keep their behavior consistent. */}
            {options.map(({ key, label, choices }) => (
              <fieldset key={key}>
                <legend>{label}</legend>
                <div className="choices">
                  {/* aria-pressed communicates selection and drives the CSS highlight.
                      Copying appearance preserves the other choices while replacing this key. */}
                  {choices.map((choice, value) => (
                    <button
                      key={choice}
                      type="button"
                      aria-pressed={appearance[key] === value}
                      onClick={() => onChange({ ...appearance, [key]: value })}
                    >
                      <small>{value}</small> {choice}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          <p className="save-status">
            Your selections are saved on this device when storage is available.
          </p>
          <div className="dress-actions">
            <Link
              className="primary-link"
              to="/world"
              state={{ name: name.trim() || "Player" }}
              onClick={() => {
                try {
                  sessionStorage.setItem("osaka-player-name", name.trim() || "Player");
                } catch {
                  /* Navigation state preserves the name when storage is unavailable. */
                }
              }}
            >
              Enter the world &rarr;
            </Link>
            <button
              className="reset-button"
              type="button"
              onClick={() => onChange({ ...defaultAppearance })}
            >
              Reset look
            </button>
          </div>
        </section>
        <section className="character-preview" aria-label="Live character preview">
          {/* Preview uses the same character with a closer camera and no castle movement. */}
          <World appearance={appearance} preview />
        </section>
      </main>
    </>
  );
}
