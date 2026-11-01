import { useEffect, useState } from "react";
import App from "./App.jsx";
import { lockApp, setAppLockCallback } from "./lib/appLock.js";
import {
  getVaultStatus,
  lockVault,
  setupVault,
  unlockVault,
} from "./lib/localVault.js";

export default function LocalGate() {
  const [mode, setMode] = useState("loading");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [backupFile, setBackupFile] = useState(null);
  const [startFresh, setStartFresh] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    getVaultStatus()
      .then(setMode)
      .catch((reason) => {
        console.error("Could not open local finance storage.", reason);
        setError(reason.message);
        setMode("error");
      });

    if (import.meta.env.PROD && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/service-worker.js").catch((reason) => {
        console.error("Could not enable offline app support.", reason);
      });
    } else if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistration().then((registration) => {
        if (registration?.active?.scriptURL.endsWith("/service-worker.js")) {
          registration.unregister();
        }
      }).catch((reason) => {
        console.error("Could not disable offline support during development.", reason);
      });
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    let timer;
    const lock = () => {
      clearTimeout(timer);
      lockVault();
      setReady(false);
      setMode("locked");
      setPin("");
      setConfirmPin("");
    };
    const handleVisibility = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") {
        timer = setTimeout(lock, 60_000);
      }
    };
    setAppLockCallback(lock);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
      setAppLockCallback(null);
    };
  }, [ready]);

  const enter = async (event) => {
    event.preventDefault();
    setError("");
    try {
      if (mode === "setup") {
        if (pin.length < 10) throw new Error("Use at least 10 characters.");
        if (pin !== confirmPin) throw new Error("Passphrases do not match.");
        if (!backupFile && !startFresh) {
          throw new Error("Choose your JSON backup, or select the option to start fresh.");
        }
        const backup = backupFile
          ? JSON.parse(await backupFile.text())
          : null;
        await setupVault(pin, backup);
      } else {
        await unlockVault(pin);
      }
      setReady(true);
      setPin("");
      setConfirmPin("");
    } catch (reason) {
      setError(reason.message || "Could not unlock local data.");
    }
  };

  if (ready) return <App onLock={lockApp} />;
  if (mode === "loading") {
    return <main className="auth-page">Opening your encrypted local vault…</main>;
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="brand-mark">₹</div>
        <span className="eyebrow">Private, on this device</span>
        <h1>{mode === "setup" ? "Create your local vault" : "Unlock your vault"}</h1>
        <p>
          Your records are encrypted on this device. They are not sent to
          Render, Clerk, or a cloud database.
        </p>
        {mode !== "error" && (
          <form className="auth-actions" onSubmit={enter}>
            <label className="field start-fresh">
              <span>{mode === "setup" ? "Create a passphrase (at least 10 characters)" : "Passphrase"}</span>
              <input
                autoComplete={mode === "setup" ? "new-password" : "current-password"}
                autoFocus
                minLength={10}
                onChange={(event) => setPin(event.target.value)}
                required
                type="password"
                value={pin}
              />
            </label>
            {mode === "setup" && (
              <>
                <label className="field">
                  <span>Confirm passphrase</span>
                  <input
                    autoComplete="new-password"
                    minLength={10}
                    onChange={(event) => setConfirmPin(event.target.value)}
                    required
                    type="password"
                    value={confirmPin}
                  />
                </label>
                <label className="field">
                  <span>Import your latest JSON backup</span>
                  <input
                    accept="application/json"
                    onChange={(event) => setBackupFile(event.target.files?.[0] || null)}
                    type="file"
                  />
                </label>
                <label className="field">
                  <span>
                    <input
                      checked={startFresh}
                      onChange={(event) => setStartFresh(event.target.checked)}
                      type="checkbox"
                    />{" "}
                    I don’t need to import existing records; start with empty
                    data
                  </span>
                </label>
                <p className="muted">
                  Keep your passphrase safe. There is no password reset or
                  cloud recovery. If you forget it, the encrypted data cannot
                  be recovered without a backup.
                </p>
              </>
            )}
            {error && <div className="error">{error}</div>}
            <button className="btn primary" type="submit">
              {mode === "setup" ? "Create local vault" : "Unlock"}
            </button>
          </form>
        )}
        {mode === "error" && <div className="error">{error}</div>}
      </section>
    </main>
  );
}
