-- A synthetic snapshot: the columns of aminte's schema that the importer reads,
-- without aminte's CHECKs and triggers. The importer's test also runs once
-- against aminte's real schema (plan 002, P5).
CREATE TABLE entities (id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, preferred_name_key TEXT NOT NULL,
  day TEXT, is_journal INTEGER NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT, body TEXT NOT NULL DEFAULT '');
CREATE TABLE entity_names (id INTEGER PRIMARY KEY, entity_id INTEGER NOT NULL, title TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE);
CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, birth_day TEXT, death_day TEXT);
CREATE TABLE metrics (id INTEGER PRIMARY KEY, unit TEXT NOT NULL DEFAULT '', daily INTEGER NOT NULL DEFAULT 0);
CREATE TABLE files (id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL, mime TEXT NOT NULL, preview BLOB);
CREATE TABLE links (id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, kind TEXT NOT NULL);
CREATE TABLE measurements (id INTEGER PRIMARY KEY, metric_id INTEGER NOT NULL, day TEXT NOT NULL, taken_at TEXT, tz TEXT,
  value REAL, created_at TEXT NOT NULL, source TEXT NOT NULL, import_key TEXT, supersedes_id INTEGER);

INSERT INTO entities VALUES
  (1, 'page',   '2026-11-14', NULL, 1, '2026-11-14T06:00:00.000Z', NULL, 'Walked with [[Ana]] in [[Cluj]]. Read about [[C#]].'),
  (2, 'person', 'ana pop',    NULL, 0, '2026-01-02T10:00:00.000Z', NULL, 'A friend.'),
  (3, 'page',   'cluj',       NULL, 0, '2025-05-01T09:00:00.000Z', NULL, 'A city.'),
  (4, 'page',   'c#',         NULL, 0, '2025-06-01T09:00:00.000Z', NULL, 'A language.'),
  (5, 'metric', 'mood',       NULL, 0, '2024-01-01T08:00:00.000Z', NULL, 'Mood of the day.'),
  (6, 'file',   'receipt',    '2026-03-03', 0, '2026-03-04T12:00:00.000Z', NULL, 'The text of a receipt.'),
  (7, 'person', 'dan',        NULL, 0, '2020-01-01T08:00:00.000Z', '2021-01-01T08:00:00.000Z', 'Dan the barber.'),
  (8, 'page',   'places',     NULL, 0, '2024-02-02T08:00:00.000Z', NULL, 'Where I have been.'),
  (9, 'page',   'cities',     NULL, 0, '2024-02-03T08:00:00.000Z', NULL, '---' || char(10) || 'not frontmatter, a body that starts with a rule');
INSERT INTO entity_names VALUES
  (1, 1, '2026-11-14', '2026-11-14'), (2, 2, 'Ana Pop', 'ana pop'), (3, 2, 'Ana', 'ana'), (4, 3, 'Cluj', 'cluj'),
  (5, 4, 'C#', 'c#'), (6, 5, 'Mood', 'mood'), (7, 6, 'Receipt', 'receipt'), (8, 7, 'Dan', 'dan'),
  (9, 8, 'Places', 'places'), (10, 9, 'Cities', 'cities');
INSERT INTO people VALUES (2, 'Ana Pop', '1990-04-02', NULL), (7, 'Dan', NULL, NULL);
INSERT INTO metrics VALUES (5, '1-5', 1);
INSERT INTO files VALUES (6, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'image/jpeg', X'FFD8FFE000104A464946');
INSERT INTO links VALUES (1, 3, 8, 'part-of'), (2, 3, 9, 'part-of'), (3, 1, 2, 'wikilink');
INSERT INTO measurements VALUES
  (1, 5, '2026-11-13', '2026-11-13T18:00:00.000Z', 'Europe/Bucharest', 3, '2026-11-13T18:00:01.000Z', 'manual', NULL, NULL),
  (2, 5, '2026-11-14', NULL, NULL, 2, '2026-11-14T20:00:00.000Z', 'manual', NULL, NULL),
  (3, 5, '2026-11-14', NULL, NULL, 4, '2026-11-14T21:00:00.000Z', 'manual', NULL, 2),
  (4, 5, '2026-11-15', NULL, NULL, 5, '2026-11-15T20:00:00.000Z', 'manual', NULL, NULL),
  (5, 5, '2026-11-15', NULL, NULL, NULL, '2026-11-15T21:00:00.000Z', 'manual', NULL, 4),
  (6, 5, '2025-12-31', NULL, NULL, 1, '2025-12-31T20:00:00.000Z', 'scale:old', 'k1', NULL);
