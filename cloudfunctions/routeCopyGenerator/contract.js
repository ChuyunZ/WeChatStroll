// Mirrored in cloudfunctions/routeCopyGenerator/contract.js for independent deployment.
// This contract deliberately checks identifiable claims, not all Chinese semantics.
const MAX_INPUT_BYTES = 16384;
const COPY_FIELDS = ['title', 'description', 'recommendationReason'];
const LENGTHS = { title: [6, 22], description: [30, 100], recommendationReason: [20, 80] };
const TYPES = ['loop', 'out_and_back', 'point_to_point'];
const ENVIRONMENTS = ['公园', '水边', '街道', '商街'];
const HISTORY_ENVIRONMENTS = ['park', 'water', 'street', 'shoppingStreet'];
const LIKED = ['nice_view', 'quiet', 'comfortable_route', 'duration_good'];
const DISLIKED = ['too_crowded', 'too_quiet', 'distance_too_long', 'distance_too_short',
  'duration_too_long', 'duration_too_short', 'route_hard_to_walk', 'pois_not_interesting'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(v, k));
const bounded = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const size = s => Array.from(s).length;
const unsafe = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
function byteLength(value) {
  try { return unescape(encodeURIComponent(JSON.stringify(value))).length; } catch (_) { return Infinity; }
}
function normalizeHistory(h) {
  const tags = (v, allowed) => Array.isArray(v) && v.length <= allowed.length &&
    new Set(v).size === v.length && v.every(tag => allowed.includes(tag));
  if (!exact(h, ['environmentWeights', 'preferredDurationMinutes', 'crowdPreferenceSignal', 'likedTags', 'dislikedTags', 'evidenceWalkCount']) ||
      !exact(h.environmentWeights, HISTORY_ENVIRONMENTS) || !HISTORY_ENVIRONMENTS.every(k => bounded(h.environmentWeights[k], 0, 1)) ||
      !(h.preferredDurationMinutes === null || bounded(h.preferredDurationMinutes, 15, 120) && h.preferredDurationMinutes % 5 === 0) ||
      !(h.crowdPreferenceSignal === null || bounded(h.crowdPreferenceSignal, -1, 1)) ||
      !tags(h.likedTags, LIKED) || !tags(h.dislikedTags, DISLIKED) ||
      !Number.isInteger(h.evidenceWalkCount) || !bounded(h.evidenceWalkCount, 1, 20)) return null;
  return {
    environmentWeights: Object.fromEntries(HISTORY_ENVIRONMENTS.map(k => [k, h.environmentWeights[k]])),
    preferredDurationMinutes: h.preferredDurationMinutes, crowdPreferenceSignal: h.crowdPreferenceSignal,
    likedTags: [...h.likedTags].sort(), dislikedTags: [...h.dislikedTags].sort(), evidenceWalkCount: h.evidenceWalkCount
  };
}
function normalizeInput(p) {
  if (byteLength(p) > MAX_INPUT_BYTES || !exact(p, ['schemaVersion', 'routeFacts', 'preferences', 'historicalPreferenceProfile']) || p.schemaVersion !== 1) return null;
  const r = p.routeFacts, q = p.preferences;
  if (!exact(r, ['routeType', 'returnsToStart', 'distanceMeters', 'durationSeconds', 'durationMinutes', 'orderedPois']) ||
      !TYPES.includes(r.routeType) || r.returnsToStart !== (r.routeType !== 'point_to_point') ||
      !bounded(r.distanceMeters, 0, 1000000) || !bounded(r.durationSeconds, 0, 604800) ||
      r.durationMinutes !== Math.ceil(r.durationSeconds / 60) ||
      !Array.isArray(r.orderedPois) || r.orderedPois.length < 1 || r.orderedPois.length > 8 ||
      !r.orderedPois.every((poi, i) => exact(poi, ['ref', 'name', 'category']) && poi.ref === `P${i + 1}` &&
        typeof poi.name === 'string' && poi.name === poi.name.trim() && size(poi.name) >= 1 && size(poi.name) <= 120 &&
        !unsafe.test(poi.name) && !/[<>]/.test(poi.name) && HISTORY_ENVIRONMENTS.includes(poi.category))) return null;
  if (!exact(q, ['durationMinutes', 'routeType', 'crowdPreference', 'environmentPreferences']) ||
      !bounded(q.durationMinutes, 15, 120) || !Number.isInteger(q.durationMinutes) || !TYPES.includes(q.routeType) ||
      !['low', 'medium', 'high'].includes(q.crowdPreference) || !Array.isArray(q.environmentPreferences) ||
      q.environmentPreferences.length !== 4 || new Set(q.environmentPreferences).size !== 4 ||
      !q.environmentPreferences.every(e => ENVIRONMENTS.includes(e))) return null;
  return {
    schemaVersion: 1,
    routeFacts: { routeType: r.routeType, returnsToStart: r.returnsToStart, distanceMeters: r.distanceMeters,
      durationSeconds: r.durationSeconds, durationMinutes: r.durationMinutes,
      orderedPois: r.orderedPois.map(poi => ({ ref: poi.ref, name: poi.name, category: poi.category })) },
    preferences: { durationMinutes: q.durationMinutes, routeType: q.routeType, crowdPreference: q.crowdPreference,
      environmentPreferences: [...q.environmentPreferences] },
    historicalPreferenceProfile: normalizeHistory(p.historicalPreferenceProfile)
  };
}
function numberValue(text) {
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (text === '半') return 0.5;
  const digits = '零一二三四五六七八九';
  let total = 0, digit = 0;
  for (const c of text.replace(/两/g, '二')) {
    if (digits.includes(c)) digit = digits.indexOf(c);
    else if ('十百千'.includes(c)) { total += (digit || 1) * ({ 十: 10, 百: 100, 千: 1000 }[c]); digit = 0; }
    else return NaN;
  }
  return total + digit;
}
function hasWrongMeasurements(text, r) {
  const regex = /([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十百千半]+)\s*(公里|千米|km|米|分钟|小时|秒|分)(?![钟外])/gi;
  let m;
  while ((m = regex.exec(text))) {
    const value = numberValue(m[1]), unit = m[2].toLowerCase();
    // “十分悠闲” and “多一分自在” are not duration claims. Bare Chinese
    // 分 is treated as time only with an explicit duration cue.
    if (unit === '分' && !/^\d/.test(m[1]) &&
        !/(?:步行|耗时|用时|需要|时长|全程)(?:约|大约)?\s*$/.test(text.slice(0, m.index))) continue;
    let allowed;
    if (['公里', '千米', 'km'].includes(unit)) allowed = [r.distanceMeters / 1000, Number((r.distanceMeters / 1000).toFixed(1))];
    else if (unit === '米') allowed = [r.distanceMeters, Math.round(r.distanceMeters)];
    else if (unit === '秒') allowed = [r.durationSeconds];
    else if (unit === '小时') allowed = [r.durationSeconds / 3600];
    else allowed = [r.durationSeconds / 60, r.durationMinutes];
    if (!allowed.some(n => Math.abs(n - value) < 0.000001)) return true;
  }
  return false;
}
function hasUnsupportedClaim(text) {
  for (const clause of text.split(/[，。！？；]/)) {
    // A preference in one independent statement must never exempt an adjacent
    // observed claim: "喜欢公园而且沿途有路灯" must still reject the second part.
    for (const part of clause.split(/(?:但是|不过|然而|并且|而且|同时|因此|所以|于是|因为|可是|但|而|却)/)) {
      // Bare wishes/conditionals are not route observations. Keep the
      // exemption limited to this smallest recognisable statement.
      if (/(?:希望|期待|如果|假如|倘若|想要|偏好|喜欢|寻找)/.test(part)) continue;
    if (/(?:全程|沿途|这里|这条路线|道路|路面|步道|【已知地点】(?:内|里|沿线)?)(?:都|均|十分|非常|很|始终|绝对|完全|保证|是|设有|有|并不|不|没有)*\s*(?:安全|无障碍|平坦|安静|人少|拥挤|人多|没有车辆|没有台阶|有路灯|有厕所|有座椅|有樱花|有湖景)/.test(part) ||
        /(?:全程|沿途|这里|【已知地点】(?:内|里)?)(?:有|设有|配有|提供|遍布|可以欣赏到|能看到)(?:免费的?|连续的?|完善的?|盛开的?)?(?:路灯|厕所|座椅|樱花|湖景|河景|护栏|坡道|饮水|洗手间)/.test(part) ||
        /(?:保证安全|绝对安全|放心通行|零风险|全程无车|轮椅畅行|人流量为|人流量仅|每小时\d+人)/.test(part)) return true;
    }
  }
  return false;
}
// The POI list has ordered stops, not the user's original GPS starting point
// or proof that the walking polyline enters a venue or follows an inner path.
// Apply this check to location-masked prose so actual POI names are irrelevant.
function hasUnsupportedOriginOrInterior(text) {
  if (/(?:从|由|自)【已知地点】(?:附近)?(?:出发|启程|起步|开始)|以【已知地点】(?:作为|为)起点|(?:起点|出发点)(?:是|位于|设在|在)【已知地点】|(?:起于|始于)【已知地点】/.test(text)) return true;
  // A POI category/name is not verified evidence of a traversed park footpath,
  // a quiet inner corner or even entering the venue.
  const interior = /(?:【已知地点】(?:里|内|中|里面|内部)|(?:园子?|公园|景区|商场|广场)(?:里|内|中|里面|内部))/;
  if (/(?:【已知地点】(?:里|内|中|里面|内部)|(?:园子?|公园|景区|商场|广场)(?:里|内|中|里面|内部))(?:的)?(?:小径|小路|步道|栈道|林荫道|石板路|绿道|园路|安静(?:的)?角落|宁静(?:的)?角落)/.test(text)) return true;
  if (/(?:走进|步入|进入|穿过|穿行于|沿着|顺着|漫步于|漫步在|走在)(?:【已知地点】(?:里|内|中|里面|内部)?|(?:园子?|公园|景区|商场|广场)(?:里|内|中|里面|内部))/.test(text)) return true;
  if (new RegExp(`(?:在|于)${interior.source}(?:散步|漫步|穿行|走走|游览)`).test(text)) return true;
  return false;
}
const rejectCopy = (reason, field = null) => ({ copy: null, reason, field });
function validateCopyDetailed(copy, payload) {
  if (!exact(copy, COPY_FIELDS)) return rejectCopy('INVALID_FIELDS');
  const result = {};
  for (const key of COPY_FIELDS) {
    if (typeof copy[key] !== 'string') return rejectCopy('INVALID_FIELD_TYPE', key);
    const value = copy[key].trim(), [min, max] = LENGTHS[key];
    if (size(value) < min || size(value) > max) return rejectCopy('INVALID_LENGTH', key);
    if (unsafe.test(value) || /[<>]|```|https?:\/\//i.test(value)) return rejectCopy('UNSAFE_TEXT', key);
    result[key] = value;
  }
  const r = payload.routeFacts;
  // Longest names first; names can contain numbers, ordinary words or other names.
  const names = [...new Set(r.orderedPois.map(p => p.name))].sort((a, b) => b.length - a.length);
  const masked = COPY_FIELDS.map(key => names.reduce((s, name) => s.split(name).join('【已知地点】'), result[key]));
  for (let index = 0; index < masked.length; index++) {
    const text = masked[index], field = COPY_FIELDS[index];
    if (hasWrongMeasurements(text, r)) return rejectCopy('WRONG_MEASUREMENT', field);
    // Unknown explicit references and recognisable named destinations only.
    // Generic wishes such as “去公园换换心情” are not factual environment claims.
    if (/\bP\d+\b/.test(text) || /(?:前往|途经|抵达|到达|走进|经过)(?:位于)?[^，。！？；、【】\s]{2,24}(?:公园|广场|大街|大道|步行街|博物馆|纪念馆|美术馆|景区|景点|古镇|寺|庙|塔|街|路|湖|桥)/.test(text) ||
        /[“「][^”」]{2,24}(?:公园|广场|大街|大道|博物馆|街|路|湖|桥)[”」]/.test(text)) return rejectCopy('INVALID_POI', field);
    if (hasUnsupportedClaim(text)) return rejectCopy('UNSUPPORTED_FACT', field);
    if (hasUnsupportedOriginOrInterior(text)) return rejectCopy('INVALID_ORIGIN_OR_INTERIOR', field);
    if (!r.returnsToStart && /(?:并|再|最后|随后|最终)返回起点|回到出发点|环形路线|往返路线/.test(text)) return rejectCopy('WRONG_ROUTE_TYPE', field);
    if (r.returnsToStart && /(?:无需|不必|不会|不再)返回起点|单程路线/.test(text)) return rejectCopy('WRONG_ROUTE_TYPE', field);
    if (/(?:向|往)(?:东|西|南|北)(?:走|行|转)|(?:左|右)转/.test(text)) return rejectCopy('NAVIGATION_INSTRUCTION', field);
  }
  // Check explicit paired ordering, without treating mere mention order as visit order.
  const joined = COPY_FIELDS.map(k => result[k]).join('。');
  for (let i = 0; i < r.orderedPois.length; i++) {
    for (let j = i + 1; j < r.orderedPois.length; j++) {
      const first = r.orderedPois[i].name, later = r.orderedPois[j].name;
      if (first === later) continue;
      for (const clause of joined.split(/[。！？；]/)) {
        const a = clause.indexOf(later), b = clause.lastIndexOf(first);
        if (a >= 0 && b > a && /先/.test(clause.slice(0, a)) && /再|然后|随后/.test(clause.slice(a + later.length, b))) return rejectCopy('WRONG_POI_ORDER');
      }
    }
  }
  const normalized = masked.map(s => s.replace(/【已知地点】|[\s，。！？；、：“”‘’·]/g, ''));
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const a = normalized[i], b = normalized[j];
      if ((a && a === b) || (Math.min(a.length, b.length) >= 16 && (a.includes(b) || b.includes(a)))) return rejectCopy('DUPLICATE_CONTENT');
    }
  }
  return { copy: result, reason: null, field: null };
}
function validateCopy(copy, payload) { return validateCopyDetailed(copy, payload).copy; }
function parseCopyDetailed(text, payload) {
  if (typeof text !== 'string') return rejectCopy('INVALID_RESPONSE_TYPE');
  if (text.length > 4096) return rejectCopy('OVERSIZED_RESPONSE');
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return rejectCopy('INVALID_JSON'); }
  // This is a structural guard; it is not a replacement for JSON string
  // parsing or token validation.
  if ((text.match(/"(?:\\.|[^"\\])*"/g) || []).length !== 6) return rejectCopy('INVALID_JSON_TOKENS');
  return validateCopyDetailed(parsed, payload);
}
function parseCopy(text, payload) { return parseCopyDetailed(text, payload).copy; }
module.exports = { MAX_INPUT_BYTES, COPY_FIELDS, LENGTHS, byteLength, normalizeHistory, normalizeInput, validateCopy, parseCopy, validateCopyDetailed, parseCopyDetailed };
