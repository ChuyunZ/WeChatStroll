const ROUTES = { loop: '环线散步', out_and_back: '往返散步', point_to_point: '单程散步' };
function durationText(seconds) {
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分钟` : '', rest ? `${rest} 秒` : ''].filter(Boolean).join(' ') || '0 秒';
}
function historyCard(item) {
  const date = new Date(item.startTime);
  const pad = n => String(n).padStart(2, '0');
  return {
    walkId: item.walkId,
    dateText: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    routeText: ROUTES[item.routeType], statusText: item.status === 'completed' ? '已完成' : '提前结束',
    statusClass: item.status === 'completed' ? 'completed' : 'ended-early',
    plannedText: `计划 ${item.requestedDurationMinutes} 分钟`, actualText: `实际经过 ${durationText(item.actualDurationSeconds)}`,
    ratingText: item.rating === null ? '尚未评价' : `评分 ${item.rating} / 5`, hasRating: item.rating !== null
  };
}
module.exports = { historyCard, durationText };
