jest.mock('wx-server-sdk', () => ({
  DYNAMIC_CURRENT_ENV: 'runtime', init: jest.fn(), database: jest.fn()
}))
const cloud = require('wx-server-sdk')
const { createHandler, isExpectedTimer } = require('../cloudfunctions/mapQuotaCleanup/index')
const time = 1792500000000
const timer = { Type:'Timer',TriggerName:'dailyIngressRetention',
  Time:new Date(time).toISOString(), Message:'' }

test('no client event or timer can activate absent server-side mode',async()=>{
  cloud.database.mockClear()
  const run=createHandler({env:{},now:()=>time,cloudSdk:cloud,log:()=>{}})
  expect(await run(timer)).toMatchObject({error:{code:'CLEANUP_DISABLED'}})
  expect(cloud.database).not.toHaveBeenCalled()
})
test('timed-event shape and schedule freshness validation fail closed before database',async()=>{
  const run=createHandler({env:{MAP_QUOTA_CLEANUP_MODE:'dry-run'},
    now:()=>time,cloudSdk:cloud,log:()=>{}})
  for (const payload of [
    {},{Type:'Timer',TriggerName:'other',Time:timer.Time},
    {...timer,Time:'junk'}, {...timer,Time:new Date(time+200001).toISOString()},
    {...timer,Time:new Date(time-7*3600000).toISOString()},
    {...timer,Type:'HTTP'}, {...timer,Time:'2026-10-12T12:34:00+08:00'}
  ]) expect(await run(payload)).toMatchObject({
    error:{code:'CLEANUP_UNAUTHORIZED'}
  })
  expect(isExpectedTimer(timer,time)).toBe(true)
  expect(cloud.database).not.toHaveBeenCalled()
})
test('deletion requires separate operator-only env opt in, never an event field',async()=>{
  const run=createHandler({env:{MAP_QUOTA_CLEANUP_MODE:'delete'},
    now:()=>time,cloudSdk:cloud,log:()=>{}})
  const forged={...timer,mode:'delete',approval:'DELETE_EXPIRED_INGRESS'}
  expect(await run(forged)).toMatchObject({error:{code:'CLEANUP_NOT_APPROVED'}})
  expect(cloud.database).not.toHaveBeenCalled()
})
test('sdk/database failures return only fixed labels and never reveal input or stack',async()=>{
  const log=jest.fn()
  cloud.database.mockImplementationOnce(()=>{throw new Error('private-token-and-owner')})
  const run=createHandler({env:{MAP_QUOTA_CLEANUP_MODE:'dry-run'},
    now:()=>time,cloudSdk:cloud,log})
  const out=await run(timer)
  expect(out).toEqual({success:false,error:{code:'CLEANUP_UNAVAILABLE'}})
  expect(JSON.stringify([...log.mock.calls,out])).not.toContain('private-token')
  expect(log).toHaveBeenCalledWith({event:'cleanup_failed'})
})
