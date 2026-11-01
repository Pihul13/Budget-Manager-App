let lockCallback = null;

export function setAppLockCallback(callback) {
  lockCallback = callback;
}

export function lockApp() {
  lockCallback?.();
}
