import { createUser, type UserRow } from "../src/db/usersRepo";

const TEST_PASSWORD = "test-password-123";

/** Creates a real account (real argon2-hashed password row in Postgres)
 * for tests that need a user to own/collaborate on documents, without
 * every test having to spell out signup boilerplate. `emailLocal` just
 * needs to be unique per test case -- it becomes `<emailLocal>@test.local`. */
export async function createTestUser(emailLocal: string, displayName: string): Promise<UserRow> {
  return createUser(`${emailLocal}@test.local`, TEST_PASSWORD, displayName);
}

export { TEST_PASSWORD };
