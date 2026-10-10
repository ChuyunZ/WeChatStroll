const fs = require('fs');
let page;
beforeEach(() => {
  jest.resetModules();
  // A fresh Home should still open Preferences when reconciliation finds no active walk.
  jest.doMock('../miniprogram/services/active-walk-session', () => ({
    reconcileActiveWalk: jest.fn().mockResolvedValue(null)
  }));
  global.wx = {
    navigateTo: jest.fn(({ success }) => { if (success) success(); }),
    showToast: jest.fn()
  };
  global.Page = definition => { page = definition; };
  require('../miniprogram/pages/home/home');
  page.onLoad();
  page.onShow();
});
afterEach(() => { delete global.wx; delete global.Page; });
test('Home opens Profile and retains the original planning navigation', async () => {
  await page.goPreference();
  expect(wx.navigateTo).toHaveBeenLastCalledWith(expect.objectContaining({ url: '/pages/preferences/preferences' }));
  page.goProfile();
  expect(wx.navigateTo).toHaveBeenLastCalledWith({ url: '/pages/profile/profile' });
  const config = JSON.parse(fs.readFileSync('miniprogram/app.json', 'utf8'));
  expect(config.pages).toContain('pages/profile/profile'); expect(config.tabBar).toBeUndefined();
});
test.each(['home', 'profile'])('%s WXML event bindings and local styles resolve', name => {
  let definition;
  global.Page = value => { definition = value; };
  jest.resetModules(); require(`../miniprogram/pages/${name}/${name}`);
  const wxml = fs.readFileSync(`miniprogram/pages/${name}/${name}.wxml`, 'utf8');
  for (const match of wxml.matchAll(/bind(?:tap|input)="([^"]+)"/g)) expect(typeof definition[match[1]]).toBe('function');
  expect(wxml).not.toMatch(/\.map\(|\.slice\(|new Date|=>/);
  const css = fs.readFileSync(`miniprogram/pages/${name}/${name}.wxss`, 'utf8');
  const localClasses = new Set([...wxml.matchAll(/\sclass="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/)).filter(x => /^[a-z][a-z-]*$/.test(x)));
  for (const cls of localClasses) expect(css).toContain(`.${cls}`);
  if (name === 'profile') {
    expect(wxml).toContain('wx:key="walkId"');
    expect(wxml).not.toMatch(/bindtap="(?:goDetail|openDetail)"|User profile|GPS 地图/);
    expect(css).toContain('safe-area-inset-bottom');
    expect(JSON.parse(fs.readFileSync('miniprogram/pages/profile/profile.json', 'utf8')).navigationBarTitleText).toBe('我的散步');
  }
});
