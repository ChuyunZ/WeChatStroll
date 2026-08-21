const mockRoutes = [
  {
    routeId: "route_001",
    title: "河边放松路线",
    durationMinutes: 32,
    distanceMeters: 2600,
    routeType: "loop",
    crowdLevel: "medium",
    tags: ["河边", "树荫", "环形路线"],
    description: "大部分路段沿河，途中有多个休息区域。",
    recommendationReason: "符合你希望安静散步约30分钟的偏好。",
    polyline: [
  { latitude: 31.23040, longitude: 121.47370 },
  { latitude: 31.23105, longitude: 121.47395 },
  { latitude: 31.23145, longitude: 121.47475 },
  { latitude: 31.23120, longitude: 121.47560 },
  { latitude: 31.23055, longitude: 121.47600 },
  { latitude: 31.22995, longitude: 121.47545 },
  { latitude: 31.22980, longitude: 121.47445 },
  { latitude: 31.23040, longitude: 121.47370 }
]
  },
  {
    routeId: "route_002",
    title: "城市探索路线",
    durationMinutes: 42,
    distanceMeters: 3400,
    routeType: "loop",
    crowdLevel: "medium",
    tags: ["街区", "咖啡店", "城市建筑"],
    description: "路线会经过商业街区和数个城市地标。",
    recommendationReason: "适合希望探索附近街区的用户。",
    polyline: [
  { latitude: 31.23200, longitude: 121.47250 },
  { latitude: 31.23255, longitude: 121.47310 },
  { latitude: 31.23275, longitude: 121.47410 },
  { latitude: 31.23225, longitude: 121.47500 },
  { latitude: 31.23145, longitude: 121.47545 },
  { latitude: 31.23085, longitude: 121.47470 },
  { latitude: 31.23110, longitude: 121.47355 },
  { latitude: 31.23200, longitude: 121.47250 }
]
  },
  {
    routeId: "route_003",
    title: "公园轻松路线",
    durationMinutes: 24,
    distanceMeters: 1900,
    routeType: "loop",
    crowdLevel: "quiet",
    tags: ["公园", "安静", "休息点"],
    description: "路线较短，并经过多个可以休息的位置。",
    recommendationReason: "适合时间有限或当天比较疲劳的用户。",
    polyline: [
  { latitude: 31.22880, longitude: 121.47150 },
  { latitude: 31.22935, longitude: 121.47210 },
  { latitude: 31.23005, longitude: 121.47185 },
  { latitude: 31.23055, longitude: 121.47115 },
  { latitude: 31.23025, longitude: 121.47030 },
  { latitude: 31.22945, longitude: 121.46995 },
  { latitude: 31.22895, longitude: 121.47055 },
  { latitude: 31.22880, longitude: 121.47150 }
]
  }
];

module.exports = {
  mockRoutes
};