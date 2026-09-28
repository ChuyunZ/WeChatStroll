// Serializes request STARTS, not responses. One scheduler per planning session.
function createWalkingProviderScheduler(minIntervalMs) {
  let queue = Promise.resolve()
  let lastStart = null
  return function schedule(request) {
    let response
    const started = queue.then(async () => {
      while (lastStart !== null && Date.now() - lastStart < minIntervalMs) {
        await new Promise(resolve => setTimeout(resolve, minIntervalMs - (Date.now() - lastStart)))
      }
      lastStart = Date.now()
      // Invoke within the start queue, but let subsequent starts proceed while
      // this provider response is pending. Catch sync throws as rejections.
      try { response = Promise.resolve(request()) } catch (error) { response = Promise.reject(error) }
      response.catch(() => {})
    })
    queue = started.catch(() => {})
    return started.then(() => response)
  }
}

module.exports = { createWalkingProviderScheduler }
