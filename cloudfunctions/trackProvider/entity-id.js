const crypto = require("crypto");

const ENTITY_ID_PREFIX = "usr_";
const ENTITY_HASH_LENGTH = 32;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function createEntityId(openid, secret) {
  if (!isNonEmptyString(openid)) {
    throw new Error("OPENID must be a non-empty string.");
  }

  if (!isNonEmptyString(secret)) {
    throw new Error("Entity ID secret must be a non-empty string.");
  }

  const digest = crypto
    .createHmac("sha256", secret)
    .update(openid)
    .digest("hex");

  return `${ENTITY_ID_PREFIX}${digest.slice(0, ENTITY_HASH_LENGTH)}`;
}

module.exports = {
  ENTITY_ID_PREFIX,
  ENTITY_HASH_LENGTH,
  createEntityId
};