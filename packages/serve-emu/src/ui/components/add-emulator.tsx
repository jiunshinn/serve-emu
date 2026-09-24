import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { AvdCatalog } from "../../shared/avd-contracts";
import "./add-emulator.css";

function failureMessage(error: unknown, status: number, fallback: string): string {
  if (status === 404) {
    return "Emulator creation is unavailable on this server. Restart serve-emu from the updated project, then retry.";
  }
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && "message" in error &&
      typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export function AddEmulator({ onCreated }: { onCreated: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open && wasOpen.current) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return (
    <div className="add-emulator">
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>Add emulator</button>
      <span className="add-emulator-result" role="status">{created && `${created} created. Start it from the Devices panel.`}</span>
      {open && <AddEmulatorDialog
        onClose={() => setOpen(false)}
        onCreated={(name) => { setCreated(name); onCreated(name); setOpen(false); }}
      />}
    </div>
  );
}

function AddEmulatorDialog({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const id = useId();
  const [catalog, setCatalog] = useState<AvdCatalog | null>(null);
  const [profile, setProfile] = useState("");
  const [image, setImage] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const response = await fetch("/api/avds/catalog", { signal: controller.signal, cache: "no-store" });
        const json = await response.json() as AvdCatalog & { ok?: boolean; error?: unknown };
        if (!response.ok || !json.ok) throw new Error(failureMessage(json.error, response.status, "Could not load emulator options."));
        if (controller.signal.aborted) return;
        setCatalog(json);
        setProfile(json.profiles.find((option) => option.id === "pixel_fold")?.id ?? json.profiles[0]?.id ?? "");
        setImage(json.images[0]?.id ?? "");
      } catch (err) {
        if (!controller.signal.aborted) { setCatalog(null); setError(err instanceof Error ? err.message : String(err)); }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [revision]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setCreating(true);
    setError("");
    try {
      const response = await fetch("/api/avds/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), profile, image }),
      });
      const json = await response.json() as { ok?: boolean; avd?: string; error?: unknown };
      if (!response.ok || !json.ok || !json.avd) throw new Error(failureMessage(json.error, response.status, "Could not create emulator."));
      onCreated(json.avd);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
  }

  const foldable = catalog?.profiles.find((option) => option.id === profile)?.foldable;
  const ready = !!catalog?.profiles.length && !!catalog.images.length && !loading;
  return (
    <dialog ref={dialog} className="add-emulator-dialog" aria-labelledby={`${id}-title`}
      onCancel={(event) => { event.preventDefault(); if (!inFlight.current) onClose(); }}>
      <form onSubmit={(event) => void submit(event)} aria-busy={creating || loading}>
        <h2 id={`${id}-title`}>Add emulator</h2>
        <p>Create a virtual Android device on this computer.</p>
        {loading && <p role="status">Loading hardware profiles and installed images…</p>}
        {error && <p className="add-emulator-error" role="alert">{error}</p>}
        {!loading && !catalog && <button type="button" onClick={() => setRevision((value) => value + 1)}>Retry</button>}
        {catalog && <>
          <fieldset disabled={creating || loading}>
            <label htmlFor={`${id}-name`}>Emulator name</label>
            <input id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)}
              placeholder="My_Fold" autoFocus required maxLength={80} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,79}"
              aria-describedby={`${id}-name-help`} />
            <small id={`${id}-name-help`}>Use letters, numbers, underscores or hyphens.</small>
            <label htmlFor={`${id}-profile`}>Hardware profile</label>
            <select id={`${id}-profile`} value={profile} onChange={(event) => setProfile(event.target.value)} required>
              {[true, false].map((foldable) => <optgroup key={String(foldable)} label={foldable ? "Foldables" : "Other devices"}>
                {catalog.profiles.filter((option) => option.foldable === foldable).map((option) =>
                  <option key={option.id} value={option.id}>{option.name}</option>)}
              </optgroup>)}
            </select>
            {foldable && <small>Test folding and adaptive layouts with stock Android. Samsung One UI is not included.</small>}
            {!catalog.profiles.length && <small>No hardware profiles found. Update Android SDK Command-line Tools, then reload options.</small>}
            <label htmlFor={`${id}-image`}>Android system image</label>
            <select id={`${id}-image`} value={image} onChange={(event) => setImage(event.target.value)} required>
              {catalog.images.length ? catalog.images.map((option) =>
                <option key={option.id} value={option.id}>{option.name} · {option.abi}</option>) : <option value="">No compatible images installed</option>}
            </select>
            <small>{catalog.images.length ? "Uses an installed image. No system image download needed." : "Install a system image for this computer’s architecture in Android Studio → SDK Manager → SDK Platforms (Show Package Details), then reload options."}</small>
            <button className="add-emulator-reload" type="button" onClick={() => setRevision((value) => value + 1)}>Reload options</button>
          </fieldset>
        </>}
        <div className="add-emulator-footer">
          <button type="button" disabled={creating} onClick={onClose}>Cancel</button>
          <button type="submit" className="add-emulator-submit" disabled={!ready || creating || !name.trim()}>
            {creating ? "Creating…" : "Create emulator"}
          </button>
        </div>
        {creating && <p role="status">Creating the emulator. This may take a minute.</p>}
      </form>
    </dialog>
  );
}
