import React, { useEffect, useRef, useState } from "react";
import { Download, HardDrive, LockKeyhole, Upload } from "lucide-react";
import { api, downloadBackup } from "../lib/api.js";
import { changeVaultPassphrase } from "../lib/localVault.js";
export default function Settings({
  theme,
  setTheme,
  displayName,
  onDisplayNameChange,
}) {
  const [file, setFile] = useState(null),
    [msg, setMsg] = useState(""),
    [name, setName] = useState(displayName),
    [currentPassphrase, setCurrentPassphrase] = useState(""),
    [nextPassphrase, setNextPassphrase] = useState(""),
    [confirmPassphrase, setConfirmPassphrase] = useState("");
  const input = useRef();
  useEffect(() => {
    setName(displayName);
  }, [displayName]);
  const themeSave = async (t) => {
    try {
      await api.put("/api/settings", { theme: t });
      setTheme(t);
      setMsg("");
    } catch (e) {
      setMsg(e.message);
    }
  };
  const saveName = async (e) => {
    e.preventDefault();
    const value = name.trim();
    if (!value) {
      setMsg("Enter a name to personalize your finance tracker.");
      return;
    }
    try {
      const settings = await api.put("/api/settings", { displayName: value });
      onDisplayNameChange(settings.displayName);
      setMsg("Your finance tracker name has been saved.");
    } catch (error) {
      setMsg(error.message);
    }
  };
  const localSave = async () => {
    try {
      await downloadBackup();
      setMsg("Backup exported to your laptop.");
    } catch (e) {
      setMsg(e.message);
    }
  };
  const importData = async () => {
    if (!file) return;
    if (!confirm("Replace all finance data stored on this device with this backup?")) return;
    try {
      const data = JSON.parse(await file.text());
      await api.post("/api/backup/import", data);
      setMsg("Backup restored to this device.");
      setFile(null);
    } catch (e) {
      setMsg(e.message);
    }
  };
  const savePassphrase = async (event) => {
    event.preventDefault();
    if (nextPassphrase !== confirmPassphrase) {
      setMsg("New passphrases do not match.");
      return;
    }
    try {
      await changeVaultPassphrase(currentPassphrase, nextPassphrase);
      setCurrentPassphrase("");
      setNextPassphrase("");
      setConfirmPassphrase("");
      setMsg("Local app passphrase changed.");
    } catch (error) {
      setMsg(error.message);
    }
  };
  return (
    <>
      <div className="page-actions">
        <div>
          <span className="muted">Personal app settings</span>
        </div>
      </div>
      <div className="settings-stack">
        <section className="panel">
          <div className="panel-head">
            <h2>Your finance tracker</h2>
          </div>
          <form className="setting-row name-setting" onSubmit={saveName}>
            <div>
              <strong>Display name</strong>
              <span className="muted">
                Your private workspace will be called “{name.trim() || "Your name"}’s Finance”.
              </span>
            </div>
            <input
              aria-label="Your display name"
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              placeholder="Your name"
              required
              value={name}
            />
            <button className="btn primary" type="submit">
              Save name
            </button>
          </form>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Appearance</h2>
          </div>
          <div className="setting-row">
            <div>
              <strong>Theme</strong>
              <span className="muted">Minimal light/dark interface</span>
            </div>
            <div className="segmented compact">
              {["light", "dark", "system"].map((t) => (
                <button
                  key={t}
                  className={theme === t ? "selected" : ""}
                  onClick={() => themeSave(t)}
                >
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-row">
            <div>
              <strong>Base currency</strong>
              <span className="muted">Fixed for this personal tracker</span>
            </div>
            <span className="badge">₹ INR</span>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Backup & restore</h2>
          </div>
          <div className="backup-box">
            <div className="backup-icon">
              <HardDrive size={20} />
            </div>
            <div>
              <strong>Keep a portable backup</strong>
              <span className="muted">
                Export all accounts, transactions, budgets, goals, funds,
                recurring rules and settings as JSON to move between devices.
                This backup is not encrypted; keep it private.
              </span>
            </div>
            <button className="btn" onClick={localSave}>
              <Download size={16} /> Export
            </button>
          </div>
          <div className="backup-box">
            <div className="backup-icon">
              <Upload size={20} />
            </div>
            <div>
              <strong>Restore a backup</strong>
              <span className="muted">
                Importing replaces all finance data stored on this device.
              </span>
            </div>
            <input
              ref={input}
              className="hidden"
              type="file"
              accept="application/json"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
            <button className="btn" onClick={() => input.current?.click()}>
              Choose file
            </button>
            {file && (
              <button className="btn primary" onClick={importData}>
                Restore
              </button>
            )}
          </div>
          {msg && <div className="notice">{msg}</div>}
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Local app lock</h2>
          </div>
          <div className="backup-box">
            <div className="backup-icon">
              <LockKeyhole size={20} />
            </div>
            <div>
              <strong>Change your passphrase</strong>
              <span className="muted">
                Your passphrase encrypts this device’s local data. It cannot be
                reset; keep a backup in a safe place.
              </span>
            </div>
          </div>
          <form className="form-grid" onSubmit={savePassphrase}>
            <label className="field">
              <span>Current passphrase</span>
              <input
                autoComplete="current-password"
                onChange={(event) => setCurrentPassphrase(event.target.value)}
                required
                type="password"
                value={currentPassphrase}
              />
            </label>
            <label className="field">
              <span>New passphrase (at least 10 characters)</span>
              <input
                autoComplete="new-password"
                minLength={10}
                onChange={(event) => setNextPassphrase(event.target.value)}
                required
                type="password"
                value={nextPassphrase}
              />
            </label>
            <label className="field">
              <span>Confirm new passphrase</span>
              <input
                autoComplete="new-password"
                minLength={10}
                onChange={(event) => setConfirmPassphrase(event.target.value)}
                required
                type="password"
                value={confirmPassphrase}
              />
            </label>
            <button className="btn primary" type="submit">
              Change passphrase
            </button>
          </form>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Data model</h2>
          </div>
          <div className="muted settings-copy">
            Financial records are encrypted with your passphrase and stored in
            this browser’s local IndexedDB. They do not sync between devices
            and are never sent to an app server. Lock the app before leaving
            the device, and keep regular backups.
          </div>
        </section>
      </div>
    </>
  );
}
