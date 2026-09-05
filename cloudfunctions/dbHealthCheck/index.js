const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

exports.main = async () => {
  let documentId = null

  try {
    const createdAt = new Date().toISOString()

    const writeResult = await db.collection('users').add({
      data: {
        openid: '__db_health_check__',
        username: 'Database Health Check',
        totalWalks: 0,
        createdAt
      }
    })

    documentId = writeResult._id

    const readResult = await db
      .collection('users')
      .doc(documentId)
      .get()

    await db
      .collection('users')
      .doc(documentId)
      .remove()

    documentId = null

    return {
      success: true,
      message: 'Database write, read, and delete succeeded',
      document: readResult.data,
      timestamp: createdAt
    }
  } catch (error) {
    console.error('[Database Health Check] Failed:', error)

    if (documentId) {
      try {
        await db
          .collection('users')
          .doc(documentId)
          .remove()
      } catch (cleanupError) {
        console.error('[Database Health Check] Cleanup failed:', cleanupError)
      }
    }

    return {
      success: false,
      message: 'Database health check failed',
      error: error.message
    }
  }
}