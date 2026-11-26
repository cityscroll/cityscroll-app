// Every fixture is non-deliverable and unique to this test process.
const domain = crypto.randomUUID() + ".invalid";
export function fixtureRecipient(localPart) {
  return localPart + "@" + domain;
}
