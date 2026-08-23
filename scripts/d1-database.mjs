const D1_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function selectD1DatabaseIdentifier(database, databases) {
  if (D1_UUID.test(database)) return database;
  const match = databases.find((item) => item.name === database);
  if (!match?.uuid) throw new Error(`找不到 D1 database：${database}`);
  return match.uuid;
}

export function resolveD1DatabaseIdentifier(database, run) {
  if (D1_UUID.test(database)) return database;
  const databases = JSON.parse(run("pnpm", ["exec", "wrangler", "d1", "list", "--json"]));
  return selectD1DatabaseIdentifier(database, databases);
}
