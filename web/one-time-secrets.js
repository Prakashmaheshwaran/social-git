// @ts-check

/**
 * Copy a one-time secret (API secret or invitation token) to the clipboard.
 *
 * Returns `true` only when the clipboard write succeeded, in which case the
 * caller must immediately clear the value from application state (and
 * re-render so it leaves the DOM). Returns `false` when the write failed or
 * no clipboard is available, in which case the caller must retain the value
 * so the user can manually reveal/copy it.
 *
 * @param {string} value the one-time secret to copy
 * @param {{ writeText: (value: string) => Promise<void> } | null | undefined} clipboard clipboard to write through
 * @returns {Promise<boolean>} whether the caller should clear the secret
 */
export async function copyOneTimeValue(value, clipboard) {
  try {
    if (!clipboard || typeof clipboard.writeText !== "function") return false;
    if (typeof value !== "string" || value.length === 0) return false;
    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
