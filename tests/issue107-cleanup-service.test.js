const { runCleanup, MAX_PAGES, CONTROL_ID } = require('../cloudfunctions/mapQuotaCleanup/service')
const { INGRESS_RETENTION_MS } = require('../cloudfunctions/mapQuotaCleanup/retention')
const { WINDOW_MS, POLICIES } = require('../cloudfunctions/mapProvider/ingress-guard')
const DAY = 86400000
const time = 1792500000000
function owner(n) { return n.toString(16).padStart(24, '0') + 'a'.repeat(40) }
function id(n) { return 'ingress_' + owner(n).slice(0, 24) }
function oldRecord(n) {
  const past = time - INGRESS_RETENTION_MS - DAY
  return { _id: id(n), ownerHash: owner(n), updatedAtMs: past,
    windowStartMs: past, counts: {
      nearbyPois: 1, walkingRoute: 3, quotaStatus: 1, closePlanning: 0 }, leases: [] }
}
function fakeDb(rows = [], hooks = {}) {
  const docs = new Map(rows.map(x => [x._id, x]))
  const versions = new Map()
  const op = test => ({
    test, and(next) { return op(x => test(x) && next.test(x)) }
  })
  const command = {
    gte: x => op(v => v >= x), gt: x => op(v => v > x),
    lt: x => op(v => v < x)
  }
  const db = {
    docs, command, transactions: 0, deleteCount: 0,
    collection(collection) {
      if (collection !== 'map_planning_quotas') throw Error('wrong collection')
      return { where(filter) {
        if (!filter._id || !filter._id.test) throw Error('bad filter')
        return {
          orderBy(key, dir) {
            if (key !== '_id' || dir !== 'asc') throw Error('unsorted query')
            return { limit(size) {
              if (size !== 25) throw Error('unbounded scan')
              return { async get() {
                if (hooks.beforeList) await hooks.beforeList(db)
                const data = [...docs.values()]
                  .filter(x => filter._id.test(x._id))
                  .sort((a,b) => a._id.localeCompare(b._id))
                  .slice(0,size)
                return { data }
              } }
            } }
          }
        }
      } }
    },
    async startTransaction() {
      db.transactions++
      const touched = new Set(), writes = new Map()
      const readVersions = new Map(versions)
      const tx = {
        collection(collection) {
          if (collection !== 'map_planning_quotas') throw Error('bad collection')
          return { doc(key) {
            return {
              async get() {
                touched.add(key)
                return { data: docs.get(key) || null }
              },
              async set({ data }) { writes.set(key, data); touched.add(key) },
              async delete() { writes.set(key, null); touched.add(key) }
            }
          } }
        },
        async commit() {
          if (hooks.beforeCommit) await hooks.beforeCommit({ db, writes })
          if ([...touched].some(key => versions.get(key) !== readVersions.get(key))) {
            throw new Error('transaction conflict')
          }
          for (const [key,value] of writes) {
            if (value === null) { docs.delete(key); db.deleteCount++ }
            else docs.set(key,value)
            versions.set(key, (versions.get(key) || 0) + 1)
          }
        },
        async rollback() {}
      }
      return tx
    },
    modify(key, data) {
      docs.set(key, data)
      versions.set(key, (versions.get(key) || 0) + 1)
    }
  }
  return db
}
test('cleanup shares exact ingress policy with mapProvider and defaults to dry-run', async () => {
  const retention = require('../cloudfunctions/mapQuotaCleanup/retention')
  expect(retention.OPERATIONS.sort()).toEqual(Object.keys(POLICIES).sort())
  expect(retention.WINDOW_MS).toBe(WINDOW_MS)
  const db = fakeDb([oldRecord(1), {
    ...oldRecord(2), updatedAtMs: time - 1000, windowStartMs: time - 1000
  }])
  const result = await runCleanup({ db, now: () => time })
  expect(result).toMatchObject({ success:true,dryRun:true,eligible:1,
    deleted:0,scanned:2,skipped:1,cycleComplete:true })
  expect(db.deleteCount).toBe(0)
  expect(db.docs.has(id(1))).toBe(true)
  expect(db.docs.get(CONTROL_ID).cursor).toBeNull()
  expect((await runCleanup({ db, now: () => time + 1000 })).skipped).toBe(true)
  expect(db.deleteCount).toBe(0)
})
test('delete mode removes only stale records; scheduled duplicate cannot drain quota', async () => {
  const db=fakeDb([oldRecord(10),oldRecord(11),{
    ...oldRecord(12), leases: [{ id:'c'.repeat(32),operation:'quotaStatus',expiresAtMs:time+500 }]
  }])
  const summary = await runCleanup({ db, now:()=>time, mode:'delete' })
  expect(summary).toMatchObject({ scanned:3,eligible:2,deleted:2,skipped:1,failed:0 })
  expect(db.docs.has(id(10))).toBe(false)
  expect(db.docs.has(id(11))).toBe(false)
  expect(db.docs.has(id(12))).toBe(true)
  const repeat=await runCleanup({db,now:()=>time+1000,mode:'delete'})
  expect(repeat.skipped).toBe(true)
})
test('bounded four-page scan persists opaque cursor, reaches later users next day', async () => {
  const docs=Array.from({length:111},(_,i)=>oldRecord(i+1))
  const db=fakeDb(docs)
  let step=time
  const first=await runCleanup({db,now:()=>step})
  expect(first).toMatchObject({scanned:MAX_PAGES*25,pages:4,cycleComplete:false })
  expect(db.docs.get(CONTROL_ID).cursor).toBe(id(100))
  expect(db.deleteCount).toBe(0)
  step+=DAY
  const next=await runCleanup({db,now:()=>step})
  expect(next).toMatchObject({scanned:11,pages:1,cycleComplete:true})
  expect(db.docs.get(CONTROL_ID).cursor).toBeNull()
})
test('database transaction conflict stops deletion and never skips the record', async () => {
  let shouldRace=true
  const db=fakeDb([oldRecord(1)], {
    async beforeCommit({db,writes}) {
      if (shouldRace && writes.has(id(1)) && writes.get(id(1))===null) {
        shouldRace=false
        db.modify(id(1), {...oldRecord(1), updatedAtMs:time,
          windowStartMs:time, leases:[{ id:'b'.repeat(32),
            operation:'nearbyPois',expiresAtMs:time+1000 }]})
      }
    }
  })
  const result=await runCleanup({db,now:()=>time,mode:'delete'})
  expect(result).toMatchObject({failed:1,deleted:0})
  expect(db.docs.has(id(1))).toBe(true)
  expect(db.docs.get(id(1)).leases).toHaveLength(1)
})
test('fail closed for corrupted control state, clock rollback and missing scanner support',async()=>{
  const db=fakeDb([oldRecord(1)])
  db.docs.set(CONTROL_ID,{cursor:'day_2',lastStartedMs:time-1000})
  await expect(runCleanup({db,now:()=>time,mode:'delete'})).rejects.toThrow('control')
  expect(db.deleteCount).toBe(0)
  db.docs.set(CONTROL_ID,{cursor:null,lastStartedMs:time+1000})
  await expect(runCleanup({db,now:()=>time})).rejects.toThrow('control')
  db.docs.delete(CONTROL_ID)
  db.command=null
  await expect(runCleanup({db,now:()=>time})).rejects.toThrow('query support')
  expect(db.deleteCount).toBe(0)
})
