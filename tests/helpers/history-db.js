const crypto = require('crypto');
const ownerKey = crypto.createHash('sha256').update('user').digest('hex');
function walk(index, overrides = {}) {
  const walkId = `walk-${String(index).padStart(3, '0')}`;
  return { _id: walkId, walkId, ownerKey, status: index % 2 ? 'ended_early' : 'completed',
    startTime: '2026-10-09T00:00:00.000Z', endTime: '2026-10-09T00:30:00.000Z',
    actualDurationSeconds: 1800, routeType: 'loop', requestedDurationMinutes: 30,
    trajectoryEnabled: false, trajectoryPartial: false, trajectoryEndTimeMs: Date.parse('2026-10-09T00:30:00.000Z'),
    ...overrides };
}
// Query evaluator applies predicates, ordering, limits and projection, rather than returning preselected pages.
function historyDb(walks = [], feedback = []) {
  const data = { walks, feedback };
  const calls = [];
  const state = { data, calls, intercept: null };
  state.db = {
    command: Object.fromEntries(['lt', 'gt', 'in'].map(op => [op, value => ({ op, value })])),
    collection(name) {
      const query = { name, order: [] };
      const chain = {
        where(value) { query.where = value; return chain; },
        orderBy(key, direction) { query.order.push([key, direction]); return chain; },
        limit(value) { query.limit = value; return chain; },
        field(value) { query.field = value; return chain; },
        async get() { return execute('get'); },
        async count() { return execute('count'); }
      };
      function execute(method) {
        query.method = method;
        calls.push(query);
        if (state.intercept) {
          const overridden = state.intercept(query);
          if (overridden !== undefined) return overridden;
        }
        let selected = data[name].filter(row => Object.entries(query.where).every(([key, condition]) => {
          if (!condition || typeof condition !== 'object') return row[key] === condition;
          if (condition.op === 'in') return condition.value.includes(row[key]);
          return condition.op === 'lt' ? row[key] < condition.value : row[key] > condition.value;
        }));
        if (method === 'count') return { total: selected.length };
        selected.sort((a, b) => {
          for (const [key, direction] of query.order) {
            if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (direction === 'asc' ? 1 : -1);
          }
          return 0;
        });
        return { data: selected.slice(0, query.limit).map(row => Object.fromEntries(
          Object.keys(query.field).filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])
        )) };
      }
      return chain;
    }
  };
  return state;
}
module.exports = { historyDb, walk, ownerKey };
