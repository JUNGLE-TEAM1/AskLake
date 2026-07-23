const approvedUsers = new Set(['asklake-api', 'asklake-materializer']);
const bcryptLine = /^([^:]+):\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;

export function validateTrinoPasswordDatabase(value) {
  const errors = [];
  if (typeof value !== 'string' || value.length === 0) {
    return ['Trino password database must be non-empty plaintext'];
  }
  const lines = value.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length !== approvedUsers.size) {
    errors.push('Trino password database must contain exactly the two approved bcrypt identities');
    return errors;
  }
  const seen = new Set();
  for (const line of lines) {
    const match = line.match(bcryptLine);
    if (!match) {
      errors.push('Trino password database contains an invalid bcrypt entry');
      continue;
    }
    const [, user, costText] = match;
    if (!approvedUsers.has(user) || seen.has(user)) {
      errors.push('Trino password database contains an unapproved or duplicate identity');
    }
    seen.add(user);
    if (Number(costText) < 8) errors.push('Trino bcrypt cost must be at least 8');
  }
  for (const user of approvedUsers) {
    if (!seen.has(user)) errors.push(`Trino password database is missing ${user}`);
  }
  return errors;
}
