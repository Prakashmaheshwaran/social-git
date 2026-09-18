/**
 * Release-maintainer trust roots are source-controlled, independently reviewed,
 * and shipped in the measured runtime. Installation operators cannot extend
 * this set with an environment variable or local database row.
 *
 * The empty set is intentional: production admission remains unavailable until
 * a later reviewed source commit pins the two release-maintainer fingerprints.
 */
export const COMMITTED_ADMISSION_TRUST_ROOTS = Object.freeze({
  schema: "social-git.admission-trust-roots/v1",
  qaKeyFingerprints: Object.freeze([] as string[]),
  approverKeyFingerprints: Object.freeze([] as string[]),
});
