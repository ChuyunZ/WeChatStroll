const { PROFILE_HISTORY_LIMIT } = require('./profile-schema');
const { canonicalWalks } = require('./profile-builder');
const WALK_FIELDS = { _id: true, walkId: true, ownerKey: true, status: true, endTime: true,
  requestedDurationMinutes: true, actualDurationSeconds: true,
  'preferences.durationMinutes': true, 'preferences.environmentPreferences': true, 'preferences.crowdPreference': true };
const FEEDBACK_FIELDS = { _id: true, walkId: true, ownerKey: true, createdAt: true, rating: true,
  wouldRecommend: true, observedCrowdLevel: true, positiveTags: true, negativeTags: true };
function conflict(error) {
  return error && (error.code === 'DATABASE_TRANSACTION_CONFLICT' ||
    /\bDATABASE_TRANSACTION_CONFLICT\b|\bdatabase transaction conflict\b|\bwrite conflict\b/i.test([error.message, error.errMsg].join(' ')));
}
const revision = record => record ? record.revision : 0;
function createStore(db) {
  const profileDoc = (database, ownerKey) => database.collection('preference_profiles').doc(ownerKey);
  return {
    async getProfile(ownerKey) {
      return (await profileDoc(db, ownerKey).get()).data || null;
    },
    async loadHistory(ownerKey) {
      // Two equality queries avoid an OR query/index and bound reads to 2 * 20 walks.
      const batches = await Promise.all(['completed', 'ended_early'].map(status => db.collection('walks')
        .where({ ownerKey, status }).orderBy('endTime', 'desc').orderBy('walkId', 'asc')
        .limit(PROFILE_HISTORY_LIMIT).field(WALK_FIELDS).get()));
      const walks = batches.flatMap(result => result.data || []).filter(w => w._id === w.walkId);
      const ids = canonicalWalks(walks, ownerKey).map(w => w.walkId);
      if (!ids.length) return { walks: [], feedback: [] };
      const selected = new Set(ids);
      const result = await db.collection('feedback').where({ ownerKey, walkId: db.command.in(ids) })
        .limit(PROFILE_HISTORY_LIMIT).field(FEEDBACK_FIELDS).get();
      return { walks: walks.filter(w => selected.has(w.walkId)),
        feedback: (result.data || []).filter(f => f._id === f.walkId && selected.has(f.walkId) && f.ownerKey === ownerKey) };
    },
    async compareAndSet(ownerKey, expectedRevision, profile) {
      const tx = await db.startTransaction();
      try {
        const doc = profileDoc(tx, ownerKey);
        const current = (await doc.get()).data || null;
        if (revision(current) !== expectedRevision) {
          await tx.rollback();
          return { retry: true };
        }
        if (current && current.ownerKey !== ownerKey) throw new Error('Invalid profile owner.');
        let record = current;
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid profile revision.');
        if (profile && (!current || current.profile === null || current.source.fingerprint !== profile.source.fingerprint)) {
          record = { ownerKey, revision: expectedRevision + 1, ...profile };
          await doc.set({ data: record });
        } else if (!profile && current && current.profile !== null) {
          // Retain the revision fence if canonical evidence has disappeared (e.g. admin cleanup).
          record = { ownerKey, revision: expectedRevision + 1, profile: null };
          await doc.set({ data: record });
        }
        await tx.commit();
        return { retry: false, record };
      } catch (error) {
        try { await tx.rollback(); } catch (_) { /* preserve original failure */ }
        throw error;
      }
    }
  };
}
module.exports = { createStore, conflict, revision };
