Page({
  data: {
    latitude: 31.2320,
    longitude: 121.4760,

    markers: [],

    polyline: [],

    includePoints: []
  },

  onLoad() {
    this.setupMockRoute()
  },

  setupMockRoute() {
    const startPoint = {
      latitude: 31.2304,
      longitude: 121.4737
    }

    const poiPoint = {
      latitude: 31.2320,
      longitude: 121.4760
    }

    const endPoint = {
      latitude: 31.2350,
      longitude: 121.4800
    }

    const routePoints = [
      startPoint,
      poiPoint,
      endPoint
    ]

    const markers = [
      {
        id: 1,
        latitude: startPoint.latitude,
        longitude: startPoint.longitude,
        title: 'Start',
        callout: {
          content: 'Start',
          display: 'ALWAYS',
          padding: 6,
          borderRadius: 4
        }
      },
      {
        id: 2,
        latitude: poiPoint.latitude,
        longitude: poiPoint.longitude,
        title: 'Point of Interest',
        callout: {
          content: 'POI',
          display: 'ALWAYS',
          padding: 6,
          borderRadius: 4
        }
      },
      {
        id: 3,
        latitude: endPoint.latitude,
        longitude: endPoint.longitude,
        title: 'End',
        callout: {
          content: 'End',
          display: 'ALWAYS',
          padding: 6,
          borderRadius: 4
        }
      }
    ]

    const polyline = [
      {
        points: routePoints,
        width: 6,
        arrowLine: true
      }
    ]

    this.setData({
      markers,
      polyline,
      includePoints: routePoints
    })
  }
})