const { isTemporaryProviderCode } = require('../utils/provider-errors')
// The route-local pool, not the session-wide registry, defines edit permissions.
function isValidEditableOrder(route, ids) {
  const pool = route && route.editableWaypoints
  if (!Array.isArray(pool) || !pool.length || !Array.isArray(ids) || !ids.length) return false
  const allowed = new Set(pool.map(poi => poi.poiId))
  return new Set(ids).size === ids.length &&
    ids.every(id => typeof id === 'string' && allowed.has(id))
}

function copyEditableWaypoint(poi) {
  return {
    poiId: poi.poiId, name: poi.name, category: poi.category,
    latitude: poi.latitude, longitude: poi.longitude,
    ...(typeof poi.address === 'string' ? { address: poi.address } : {}),
    distanceInMeters: poi.distanceInMeters,
    ...(poi.providerMeta ? { providerMeta: { ...poi.providerMeta } } : {})
  }
}

function routeEditErrorMessage(error) {
  if (error && [error.code, error.error, error.causeCode].some(isTemporaryProviderCode)) {
    return '路线服务暂时繁忙，请稍后重试'
  }
  return '这个路线组合暂时无法构建完整步行路线，请调整地点或顺序后重试'
}

module.exports = { isValidEditableOrder, copyEditableWaypoint, routeEditErrorMessage }
