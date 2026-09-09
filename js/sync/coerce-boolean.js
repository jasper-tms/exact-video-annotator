// Shared coercion for boolean preferences. Accepts a real boolean (the current
// envelope format and values arriving synced from the cloud) as well as the
// "true"/"false" strings that earlier versions wrote straight to localStorage,
// so migrated values read correctly. Anything else falls back to the default.

export function coerceBoolean(value, defaultValue) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return defaultValue;
}
