# Personal Finance Tracker

A private, local-only Android finance app. Its Android package contains the
app itself, so no Render site, web server, Clerk, MongoDB, or API is needed to
use it. Finance data is encrypted and stored on the phone.

## Features

- Bank, cash, investment, and credit-card accounts
- Expense and income categories, transfers, budgets, saving goals, and funds
- Recurring transaction rules and credit-card statement payment tracking
- Dashboard, month history, and net-worth snapshots
- Passphrase-encrypted local data and a manual lock
- JSON backup and restore for moving data between devices
- Installable Android app that works offline

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

## Build and install on Android

Requirements: Node.js 20+ and Android Studio with Android SDK Platform 35 and
Android SDK Build Tools 35.0.0.

From the project directory, build and open the Android project:

```bash
npm install
npm --prefix client install
npm run android:sync
npm run android:open
```

In Android Studio, wait for Gradle sync, then choose **Build → Build
Bundle(s) / APK(s) → Build APK(s)**. Copy
`android/app/build/outputs/apk/debug/app-debug.apk` to the phone and open it to
install. Android may ask you to allow installs from the app used to open the
APK. The app and all finance data stay on the phone; it does not request
internet access or Android cloud backup. To update it, build and install a
newer APK; do not uninstall first, since uninstalling removes the local vault.

The public GitHub repository stores the app's source code only. Publishing that
source does not host or sync the app or any finance data.

## Local data, privacy, and recovery

- Each installation has its own local vault. There is no automatic sync with
  your laptop; use export and restore to move a backup manually.
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

If you want records from the existing hosted app, export a JSON backup from
**Settings → Backup & restore**. On the Android app's first launch, select
that backup while creating your local vault. Keep the original backup until
you verify the imported records. This Android app is separate and does not
change the old hosted app or its database.

The new app does not connect to or delete the old Atlas database. Do not remove
the old database until migration and backup verification are complete.
