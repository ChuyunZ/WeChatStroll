const GEO_POINT_EPSILON_DEGREES = 1e-6

function isValidGeoPoint(point) {
  return (
    point !== null &&
    typeof point === 'object' &&
    !Array.isArray(point) &&
    typeof point.latitude === 'number' &&
    Number.isFinite(point.latitude) &&
    point.latitude >= -90 &&
    point.latitude <= 90 &&
    typeof point.longitude === 'number' &&
    Number.isFinite(point.longitude) &&
    point.longitude >= -180 &&
    point.longitude <= 180
  )
}

function copyGeoPoint(point) {
  return {
    latitude: point.latitude,
    longitude: point.longitude
  }
}

function areGeoPointsEqual(firstPoint, secondPoint) {
  if (
    !isValidGeoPoint(firstPoint) ||
    !isValidGeoPoint(secondPoint)
  ) {
    return false
  }

  return (
    Math.abs(
      firstPoint.latitude -
        secondPoint.latitude
    ) <= GEO_POINT_EPSILON_DEGREES &&
    Math.abs(
      firstPoint.longitude -
        secondPoint.longitude
    ) <= GEO_POINT_EPSILON_DEGREES
  )
}

module.exports = {
  isValidGeoPoint,
  copyGeoPoint,
  areGeoPointsEqual
}