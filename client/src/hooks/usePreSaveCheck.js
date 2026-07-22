// Shared "run this pre-save check safely" wrapper for PersonModal/PlaceModal's
// duplicate-name / address-validity checks. Both forms fetch this fresh right
// before saving (never from a debounced background hook, which could still be
// mid-flight and stale at the moment of clicking) — but a network failure
// during that fetch must not leave Save stuck disabled forever with no error
// shown. Puts the form in `saving` while `task` runs, clears any stale error
// from a previous attempt, and — if `task` throws — surfaces the error and
// always resets `saving`, returning `{ ok: false }` so the caller bails out
// instead of proceeding to save.
export async function runPreSaveCheck(setSaving, setError, task) {
  setSaving(true);
  setError(null);
  try {
    return { ok: true, value: await task() };
  } catch (e) {
    setError(e.message);
    return { ok: false };
  } finally {
    setSaving(false);
  }
}
