const {
  ENTITY_ID_PREFIX,
  ENTITY_HASH_LENGTH,
  createEntityId
} = require("./entity-id");

describe("trackProvider entity ID", () => {
  const secret = "test-entity-secret";

  test("creates a deterministic opaque entity ID", () => {
    const first = createEntityId("openid-user-001", secret);
    const second = createEntityId("openid-user-001", secret);

    expect(first).toBe(second);
    expect(first).toMatch(/^usr_[a-f0-9]+$/);
    expect(first).toHaveLength(
      ENTITY_ID_PREFIX.length + ENTITY_HASH_LENGTH
    );
  });

  test("different users get different entity IDs", () => {
    const first = createEntityId("openid-user-001", secret);
    const second = createEntityId("openid-user-002", secret);

    expect(first).not.toBe(second);
  });

  test("different secrets produce different entity IDs", () => {
    const first = createEntityId(
      "openid-user-001",
      "secret-one"
    );

    const second = createEntityId(
      "openid-user-001",
      "secret-two"
    );

    expect(first).not.toBe(second);
  });

  test("does not expose the raw OpenID", () => {
    const openid = "sensitive-openid-value";
    const entityId = createEntityId(openid, secret);

    expect(entityId).not.toContain(openid);
  });

  test.each([
    null,
    undefined,
    "",
    "   ",
    123,
    {},
    []
  ])("rejects invalid OpenID %p", openid => {
    expect(() => {
      createEntityId(openid, secret);
    }).toThrow("OPENID must be a non-empty string.");
  });

  test.each([
    null,
    undefined,
    "",
    "   ",
    123,
    {},
    []
  ])("rejects invalid secret %p", invalidSecret => {
    expect(() => {
      createEntityId("openid-user-001", invalidSecret);
    }).toThrow(
      "Entity ID secret must be a non-empty string."
    );
  });
});