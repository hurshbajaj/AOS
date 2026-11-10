
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = `
  pragma journal_mode = wal;
  pragma foreign_keys = on;

  create table if not exists users (
    id          text primary key,
    email       text not null unique,
    name        text not null,
    org         text not null,
    phone       text,
    notes       text,
    -- Null for an account that only ever signs in through Google: there is no
    -- password to store, and a placeholder would be a password-shaped thing
    -- that happens to be unusable, which is worse than nothing.
    password    text,
    google_sub  text unique,
    verified    integer not null default 0,
    -- A second address the operator can be reached at. Separate columns
    -- rather than a table: there is exactly one of these, and a one-row
    -- child table is a join you pay for on every request for no gain.
    alt_email     text,
    alt_verified  integer not null default 0,
    created_at  text not null,
    updated_at  text not null
  );

  -- Only the hash of a session token is kept. The cookie holds the token
  -- itself, so a copy of this table is not a drawer full of live sessions.
  create table if not exists sessions (
    token_hash  text primary key,
    user_id     text not null references users(id) on delete cascade,
    created_at  text not null,
    expires_at  text not null
  );

  -- Email verification and anything else one-shot and time limited. Same
  -- reasoning as sessions: hashes only.
  create table if not exists tokens (
    token_hash  text primary key,
    user_id     text not null references users(id) on delete cascade,
    kind        text not null,
    expires_at  text not null,
    used        integer not null default 0,
    -- Wrong guesses against this code. A six-digit code is only safe
    -- because this number has a ceiling.
    tries       integer not null default 0
  );

  -- What the operator actually did: what they asked Sybil, what they injected.
  create table if not exists activity (
    id          integer primary key autoincrement,
    user_id     text not null references users(id) on delete cascade,
    kind        text not null,
    summary     text not null,
    detail      text,
    at          text not null
  );
  create index if not exists activity_by_user on activity(user_id, id desc);

  -- A saved console: a name, a note about what it is for, and the hazards the
  -- operator put in it. The fleet is not in here -- that comes down live from
  -- the catalogue and is the same for everyone. What is saved is the part the
  -- operator made.
  --
  -- Owned by an organisation rather than by a person: a console is a drill
  -- the team runs, and the second operator on shift should find the first
  -- one's work rather than an empty list. user_id stays as the creator, for
  -- attribution and so the row goes when the account does.
  create table if not exists instances (
    id          text primary key,
    user_id     text not null references users(id) on delete cascade,
    org_key     text not null default '',
    name        text not null,
    note        text,
    state       text not null default '{}',
    created_at  text not null,
    updated_at  text not null
  );
  create index if not exists instances_by_user on instances(user_id, updated_at desc);

  -- The operator's own code.
  --
  -- Source text, not a compiled artefact: the bundle is derived and can
  -- always be rebuilt, the source cannot. Kept beside the console it belongs
  -- to rather than shared across the organisation, because two scenarios
  -- running the same script would want to run two versions of it soon
  -- enough -- and a shared script silently changing what a saved drill does
  -- is the surprise this avoids.
  --
  -- The manifest column is whatever Cargo.toml the operator uploaded. It is
  -- never used as written; only its dependency table is read, and a fresh
  -- manifest is generated around it. Stored whole anyway, so the viewer can
  -- show them what they actually sent.
  create table if not exists scripts (
    id           text primary key,
    instance_id  text not null references instances(id) on delete cascade,
    user_id      text not null references users(id) on delete cascade,
    name         text not null,
    source       text not null,
    manifest     text not null default '',
    bytes        integer not null default 0,
    -- The operator's own switch, kept separate from whether it builds: a
    -- script that compiles and is turned off is a different thing from one
    -- that is broken, and the panel has to say which.
    enabled      integer not null default 1,
    position     integer not null default 0,
    created_at   text not null,
    updated_at   text not null
  );
  create index if not exists scripts_by_instance on scripts(instance_id, position, created_at);

  -- What the operator knows that the console does not.
  --
  -- The console's own figures are a mixture: positions are propagated from
  -- the public catalogue and space weather is measured, but propellant,
  -- power and link budgets are modelled, because no public feed carries
  -- them. Somebody running an actual fleet has the real numbers in their
  -- own documents, and this is where those documents go.
  --
  -- Shared across the organisation, like the consoles are, because a team
  -- reading from two different copies of the fleet spec is the problem this
  -- is meant to solve rather than a feature. The figures *read out* of them
  -- are per-console: two scenarios may reasonably hold different
  -- assumptions about the same fleet.
  --
  -- Text only. A PDF parser is a dependency, and a binary blob in here is
  -- something nobody can read, diff or trust.
  create table if not exists documents (
    id          text primary key,
    user_id     text not null references users(id) on delete cascade,
    org_key     text not null default '',
    name        text not null,
    kind        text not null default 'text',
    body        text not null,
    bytes       integer not null default 0,
    created_at  text not null,
    updated_at  text not null
  );

  -- Failed sign-in counting, so a password is not something you can simply
  -- keep guessing at.
  create table if not exists attempts (
    key    text primary key,
    count  integer not null,
    until  text not null
  );
`;

export const DEFAULT_PATH = fileURLToPath(new URL("../data/aos.db", import.meta.url));

const ADDED = [
  ["users", "alt_email", "text"],
  ["users", "alt_verified", "integer not null default 0"],
  ["tokens", "tries", "integer not null default 0"],
  ["instances", "org_key", "text not null default ''"],
  ["instances", "bundle_status", "text not null default 'none'"],
  ["instances", "bundle_bytes", "integer not null default 0"],
  ["instances", "bundle_at", "text"],
  ["instances", "bundle_log", "text not null default ''"],
];

export function open(path = DEFAULT_PATH) {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
  db.exec("create index if not exists instances_by_org on instances(org_key, updated_at desc)");
  db.exec("create index if not exists documents_by_org on documents(org_key, updated_at desc)");
  return db;
}

export function migrate(db) {
  const added = [];
  const had = db.prepare("pragma table_info(instances)").all().some((row) => row.name === "org_key");
  for (const [table, column, type] of ADDED) {
    const columns = db.prepare(`pragma table_info(${table})`).all();
    if (columns.length && !columns.some((row) => row.name === column)) {
      db.exec(`alter table ${table} add column ${column} ${type}`);
      added.push(`${table}.${column}`);
    }
  }
  if (!had && db.prepare("pragma table_info(instances)").all().length) {
    db.exec(`
      update instances set org_key = (
        select lower(trim(users.org)) from users where users.id = instances.user_id
      ) where org_key = ''
    `);
  }
  return added;
}

export const PUBLIC_FIELDS = "id, email, name, org, phone, notes, verified, created_at";

export const queries = (db) => ({
  byEmail: db.prepare("select * from users where email = ?"),
  byId: db.prepare("select * from users where id = ?"),
  byGoogle: db.prepare("select * from users where google_sub = ?"),
  publicById: db.prepare(`select ${PUBLIC_FIELDS} from users where id = ?`),

  insertUser: db.prepare(`
    insert into users (id, email, name, org, phone, notes, password, google_sub, verified, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateProfile: db.prepare(`
    update users set name = ?, org = ?, phone = ?, notes = ?, updated_at = ? where id = ?
  `),
  updatePassword: db.prepare("update users set password = ?, updated_at = ? where id = ?"),
  linkGoogle: db.prepare("update users set google_sub = ?, verified = 1, updated_at = ? where id = ?"),
  markVerified: db.prepare("update users set verified = 1, updated_at = ? where id = ?"),
  setAlt: db.prepare("update users set alt_email = ?, alt_verified = 0, updated_at = ? where id = ?"),
  clearAlt: db.prepare("update users set alt_email = null, alt_verified = 0, updated_at = ? where id = ?"),
  markAltVerified: db.prepare("update users set alt_verified = 1, updated_at = ? where id = ?"),
  byAnyEmail: db.prepare("select * from users where email = ? or alt_email = ?"),

  insertSession: db.prepare("insert into sessions (token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)"),
  session: db.prepare("select * from sessions where token_hash = ?"),
  dropSession: db.prepare("delete from sessions where token_hash = ?"),
  dropUserSessions: db.prepare("delete from sessions where user_id = ?"),
  expireSessions: db.prepare("delete from sessions where expires_at < ?"),

  insertToken: db.prepare("insert into tokens (token_hash, user_id, kind, expires_at) values (?, ?, ?, ?)"),
  token: db.prepare("select * from tokens where token_hash = ?"),
  liveToken: db.prepare("select * from tokens where user_id = ? and kind = ? and used = 0"),
  missedToken: db.prepare("update tokens set tries = tries + 1 where token_hash = ?"),
  useToken: db.prepare("update tokens set used = 1 where token_hash = ?"),
  dropTokens: db.prepare("delete from tokens where user_id = ? and kind = ?"),

  insertActivity: db.prepare("insert into activity (user_id, kind, summary, detail, at) values (?, ?, ?, ?, ?)"),
  recentActivity: db.prepare("select kind, summary, detail, at from activity where user_id = ? order by id desc limit ?"),
  recentOfKind: db.prepare("select kind, summary, detail, at from activity where user_id = ? and kind = ? order by id desc limit ?"),
  countActivity: db.prepare("select kind, count(*) as n from activity where user_id = ? group by kind"),
  trimActivity: db.prepare(`
    delete from activity
    where user_id = ? and kind = ?
      and id not in (select id from activity where user_id = ? and kind = ? order by id desc limit ?)
  `),

  instances: db.prepare(`
    select i.id, i.name, i.note, i.state, i.created_at, i.updated_at, u.name as author
    from instances i left join users u on u.id = i.user_id
    where i.org_key = ? order by i.updated_at desc
  `),
  instance: db.prepare(`
    select i.id, i.name, i.note, i.state, i.created_at, i.updated_at, u.name as author
    from instances i left join users u on u.id = i.user_id
    where i.id = ? and i.org_key = ?
  `),
  countInstances: db.prepare("select count(*) as n from instances where org_key = ?"),
  insertInstance: db.prepare("insert into instances (id, user_id, org_key, name, note, state, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)"),
  renameInstance: db.prepare("update instances set name = ?, note = ?, updated_at = ? where id = ? and org_key = ?"),
  saveInstance: db.prepare("update instances set state = ?, updated_at = ? where id = ? and org_key = ?"),
  dropInstance: db.prepare("delete from instances where id = ? and org_key = ?"),
  reKeyInstances: db.prepare("update instances set org_key = ? where user_id = ?"),

  scripts: db.prepare(`
    select s.id, s.name, s.bytes, s.enabled, s.position, s.manifest, s.created_at, s.updated_at, u.name as author
    from scripts s left join users u on u.id = s.user_id
    where s.instance_id = ? order by s.position, s.created_at
  `),
  script: db.prepare(`
    select s.id, s.instance_id, s.name, s.source, s.manifest, s.bytes, s.enabled, s.position,
           s.created_at, s.updated_at, u.name as author
    from scripts s left join users u on u.id = s.user_id
    where s.id = ? and s.instance_id = ?
  `),
  buildableScripts: db.prepare(
    "select id, name, source, manifest from scripts where instance_id = ? and enabled = 1 order by position, created_at",
  ),
  countScripts: db.prepare("select count(*) as n from scripts where instance_id = ?"),
  insertScript: db.prepare(
    "insert into scripts (id, instance_id, user_id, name, source, manifest, bytes, enabled, position, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
  ),
  updateScript: db.prepare(
    "update scripts set name = ?, source = ?, manifest = ?, bytes = ?, updated_at = ? where id = ? and instance_id = ?",
  ),
  enableScript: db.prepare("update scripts set enabled = ?, updated_at = ? where id = ? and instance_id = ?"),
  orderScript: db.prepare("update scripts set position = ?, updated_at = ? where id = ? and instance_id = ?"),
  dropScript: db.prepare("delete from scripts where id = ? and instance_id = ?"),
  nextScriptSlot: db.prepare("select coalesce(max(position), -1) + 1 as at from scripts where instance_id = ?"),

  bundle: db.prepare("select bundle_status, bundle_bytes, bundle_at, bundle_log from instances where id = ? and org_key = ?"),
  setBundle: db.prepare(
    "update instances set bundle_status = ?, bundle_bytes = ?, bundle_at = ?, bundle_log = ? where id = ? and org_key = ?",
  ),
  staleBundle: db.prepare(
    "update instances set bundle_status = case bundle_status when 'none' then 'none' else 'stale' end where id = ?",
  ),

  documents: db.prepare(`
    select d.id, d.name, d.kind, d.bytes, d.created_at, d.updated_at, u.name as author
    from documents d left join users u on u.id = d.user_id
    where d.org_key = ? order by d.updated_at desc
  `),
  document: db.prepare(`
    select d.id, d.name, d.kind, d.body, d.bytes, d.created_at, d.updated_at, u.name as author
    from documents d left join users u on u.id = d.user_id
    where d.id = ? and d.org_key = ?
  `),
  documentByName: db.prepare("select id from documents where org_key = ? and lower(name) = lower(?)"),
  countDocuments: db.prepare("select count(*) as n, coalesce(sum(bytes), 0) as total from documents where org_key = ?"),
  insertDocument: db.prepare("insert into documents (id, user_id, org_key, name, kind, body, bytes, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  updateDocument: db.prepare("update documents set name = ?, kind = ?, body = ?, bytes = ?, updated_at = ? where id = ? and org_key = ?"),
  dropDocument: db.prepare("delete from documents where id = ? and org_key = ?"),
  reKeyDocuments: db.prepare("update documents set org_key = ? where user_id = ?"),

  attempts: db.prepare("select * from attempts where key = ?"),
  bumpAttempts: db.prepare(`
    insert into attempts (key, count, until) values (?, 1, ?)
    on conflict(key) do update set count = count + 1, until = excluded.until
  `),
  clearAttempts: db.prepare("delete from attempts where key = ?"),
});
