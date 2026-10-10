const { ITEM_KEYS, historyRequest, compareHistory, historyItem, validTotals } = require('./history-schema');
const WALK_FIELDS = Object.fromEntries(['_id', 'ownerKey', ...ITEM_KEYS.filter(key => key !== 'rating')].map(key => [key, true]));
const FEEDBACK_FIELDS = { _id: true, ownerKey: true, walkId: true, rating: true };
const statuses = ['completed', 'ended_early'];
function invalidCursor() { throw Object.assign(new Error('Invalid history cursor.'), { code: 'INVALID_HISTORY_CURSOR' }); }
function rows(result, limit) {
  if (!result || !Array.isArray(result.data) || result.data.length > limit) throw new Error('Invalid history query result.');
  return result.data;
}
function publicItem(record, ownerKey) {
  if (!record || record.ownerKey !== ownerKey || record._id !== record.walkId) throw new Error('Invalid history ownership.');
  return historyItem(Object.fromEntries(ITEM_KEYS.map(key => [key, key === 'rating' ? null : record[key]])));
}
function createHistoryStore(db) {
  return {
    async listHistory(ownerKey, input) {
      const { limit, cursor } = historyRequest(input);
      if (cursor) {
        // A cursor is a bookmark, never authority. Resolve it against the current user's persisted walk.
        const anchor = rows(await db.collection('walks').where({ ownerKey, _id: cursor.walkId })
          .limit(1).field(WALK_FIELDS).get(), 1);
        if (anchor.length !== 1) invalidCursor();
        let item;
        try { item = publicItem(anchor[0], ownerKey); } catch (_) { invalidCursor(); }
        if (compareHistory(item, cursor) !== 0) invalidCursor();
      }
      const readLimit = limit + 1;
      // Disjoint ranges avoid OR/index ambiguity. Each range uses the existing compound index.
      const queries = statuses.flatMap(status => {
        const base = { ownerKey, status };
        const conditions = cursor ? [
          { ...base, endTime: cursor.endTime, walkId: db.command.gt(cursor.walkId) },
          { ...base, endTime: db.command.lt(cursor.endTime) }
        ] : [base];
        return conditions.map(condition => ({ status, condition }));
      });
      const [batches, counts] = await Promise.all([
        Promise.all(queries.map(async ({ status, condition }) => {
          const records = rows(await db.collection('walks').where(condition)
            .orderBy('endTime', 'desc').orderBy('walkId', 'asc').limit(readLimit).field(WALK_FIELDS).get(), readLimit);
          return records.map(record => {
            const item = publicItem(record, ownerKey);
            if (item.status !== status || (cursor && (item.walkId === cursor.walkId || compareHistory(cursor, item) >= 0))) {
              throw new Error('Invalid history selection.');
            }
            return item;
          });
        })),
        cursor ? null : Promise.all(statuses.map(status => db.collection('walks').where({ ownerKey, status }).count()))
      ]);
      const totals = counts === null ? null : {
        completedWalkCount: counts[0] && counts[0].total,
        endedEarlyWalkCount: counts[1] && counts[1].total
      };
      if (totals !== null && !validTotals(totals)) throw new Error('Invalid history counts.');
      const candidates = batches.flat().sort(compareHistory);
      if (new Set(candidates.map(item => item.walkId)).size !== candidates.length) throw new Error('Duplicate history identity.');
      const items = candidates.slice(0, limit);
      if (items.length) {
        const ids = items.map(item => item.walkId);
        const feedback = rows(await db.collection('feedback').where({ ownerKey, walkId: db.command.in(ids) })
          .limit(limit + 1).field(FEEDBACK_FIELDS).get(), limit + 1);
        const ratings = new Map();
        for (const record of feedback) {
          if (!record || record.ownerKey !== ownerKey || record._id !== record.walkId || !ids.includes(record.walkId) ||
              ratings.has(record.walkId) || !Number.isInteger(record.rating) || record.rating < 1 || record.rating > 5) {
            throw new Error('Invalid history feedback.');
          }
          ratings.set(record.walkId, record.rating);
        }
        items.forEach(item => { item.rating = ratings.has(item.walkId) ? ratings.get(item.walkId) : null; });
      }
      const last = items[items.length - 1];
      return { items, totals, nextCursor: candidates.length > limit
        ? { version: 1, endTime: last.endTime, walkId: last.walkId } : null };
    }
  };
}
module.exports = { createHistoryStore };
