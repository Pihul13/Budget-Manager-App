# Personal Finance Tracker

A private, local-only finance app that works offline after it has been installed
and opened once. It stores data on each device, encrypts the local vault with a
passphrase, and does not use Clerk, MongoDB, or an API.

## Features

- Bank, cash, investment, and credit-card accounts
- Expense and income categories, transfers, budgets, saving goals, and funds
- Recurring transaction rules and credit-card statement payment tracking
- Dashboard, month history, and net-worth snapshots
- Passphrase-encrypted local data and a manual lock
- JSON backup and restore for moving data between devices
- Installable PWA with offline app-shell support

## Local development

Requirements: Node.js 20+.

```bash
npm install
npm --prefix client install
npm run dev
```

Open `http://localhost:5173`. On the first run, create a passphrase with at
least 10 characters and import a backup or explicitly choose to start fresh.
No environment variables, MongoDB, Clerk, or API server are needed.

Run the production checks with:

```bash
npm run build
npm --prefix client test
```

## Install

The site must be opened online once to download and install the app shell.
After installation and the first successful load, the app shell and data work
offline. The host is only used to install the app and receive future app
updates; finance data is not sent to it.

- **Android:** open the HTTPS site in Chrome, tap the menu, then **Install
  app** or **Add to Home screen**.
- **iPhone/iPad:** open it in Safari, tap **Share**, then **Add to Home
  Screen**.
- **Laptop:** use the browser's **Install app** option when available.

## Local data, privacy, and recovery

- Each device has its own separate local vault. There is no automatic phone to
  laptop synchronization; use export and restore to move a backup manually.
- The vault is encrypted in IndexedDB using AES-GCM with a key derived from
  your passphrase. The app locks when you choose **Lock** and after it has
  been in the background for one minute.
- There is no passphrase reset. If you forget it, the encrypted vault cannot
  be recovered. Keep regular backups in a safe location.
- Exported JSON backups are **not encrypted**. Protect them like financial
  documents.
- Clearing browser/site data can erase the vault. Export a backup regularly.
- Browser-based encryption is not a substitute for keeping your phone or
  laptop physically secure. The app must be unlocked to use the data.
- Recurring rules are user-executed. Automatic card-payment entries are
  processed when the app is opened; the app cannot run background tasks while
  it is closed. Card-payment entries are only records in this tracker and
  never move real money.

## Migrating existing records

Before switching the deployed site to this local-only version, sign in to the
current hosted app and export a JSON backup from **Settings → Backup & restore**.
On the new app's first launch, select that backup while creating your local
vault. Restore it separately on each device that needs the data. Keep the
original backup until you have verified the imported records on both devices.

The new app does not connect to or delete the old Atlas database. Do not remove
the old database until migration and backup verification are complete.
