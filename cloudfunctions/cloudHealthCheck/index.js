const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

exports.main = async (event, context) => {
  return {
    success: true,
    message: 'Cloud function is working',
    timestamp: new Date().toISOString()
  }
}