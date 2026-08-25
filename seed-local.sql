-- Local-only seed data. Run with:
--   wrangler d1 execute hiking_db --local --file=./seed-local.sql
-- Safe to re-run; uses INSERT OR REPLACE.

INSERT OR REPLACE INTO events (id, title, description, event_date, location, status, created_at, updated_at) VALUES
  ('demo-001', 'Sunrise Ridge Loop',
   'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
   '2026-06-07T07:30',  'Sunrise Trailhead car park', 'active', '2026-05-01T10:00:00Z', '2026-05-01T10:00:00Z'),

  ('demo-002', 'Hidden Falls Traverse',
   'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
   '2026-06-14T08:00',  'River bridge, lower picnic area', 'active', '2026-05-02T10:00:00Z', '2026-05-02T10:00:00Z'),

  ('demo-003', 'Misty Ferns Circuit',
   'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.',
   '2026-06-21T09:00',  'Forest road end, gate 3', 'active', '2026-05-03T10:00:00Z', '2026-05-03T10:00:00Z'),

  ('demo-004', 'Black Tarn Overnighter',
   'Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt. Two-day trip — bring a tent and dinner.',
   '2026-05-30T06:00',  'DOC information centre', 'active', '2026-05-10T10:00:00Z', '2026-05-10T10:00:00Z'),

  ('demo-005', 'Pillar Rock Day Hike',
   'At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque corrupti quos dolores et quas molestias excepturi sint occaecati cupiditate non provident.',
   '2026-05-17T08:30',  'Old quarry road', 'active', '2026-04-20T10:00:00Z', '2026-04-20T10:00:00Z'),

  ('demo-006', 'Tussock Plateau Scramble',
   'Temporibus autem quibusdam et aut officiis debitis aut rerum necessitatibus saepe eveniet ut et voluptates repudiandae sint et molestiae non recusandae.',
   '2026-05-03T07:00',  'High pass car park', 'active', '2026-04-05T10:00:00Z', '2026-04-05T10:00:00Z'),

  ('demo-007', 'Coastal Cliffs Walk',
   'Itaque earum rerum hic tenetur a sapiente delectus, ut aut reiciendis voluptatibus maiores alias consequatur aut perferendis doloribus asperiores repellat.',
   '2026-04-19T09:00',  'South headland reserve', 'active', '2026-03-25T10:00:00Z', '2026-03-25T10:00:00Z'),

  ('demo-008', 'Storm-Cancelled Glacier Walk',
   'Ut enim ad minima veniam, quis nostrum exercitationem ullam corporis suscipit laboriosam, nisi ut aliquid ex ea commodi consequatur. (Cancelled due to weather.)',
   '2026-05-24T08:00',  'Glacier valley DOC hut', 'cancelled', '2026-05-15T10:00:00Z', '2026-05-23T18:00:00Z');

-- A handful of RSVPs so the "X going" counter isn't all zero.
INSERT OR REPLACE INTO rsvps (id, event_id, name, email, status, created_at) VALUES
  ('r-1', 'demo-001', 'Alice Walker', 'alice@example.com', 'going', '2026-05-02T10:00:00Z'),
  ('r-2', 'demo-001', 'Bob Trail',    'bob@example.com',   'going', '2026-05-03T11:00:00Z'),
  ('r-3', 'demo-001', 'Cara Summit',  'cara@example.com',  'going', '2026-05-04T12:00:00Z'),
  ('r-4', 'demo-002', 'Bob Trail',    'bob@example.com',   'going', '2026-05-05T10:00:00Z'),
  ('r-5', 'demo-002', 'Dan Ridge',    'dan@example.com',   'going', '2026-05-06T10:00:00Z'),
  ('r-6', 'demo-004', 'Alice Walker', 'alice@example.com', 'going', '2026-05-11T10:00:00Z'),
  ('r-7', 'demo-004', 'Eve Valley',   'eve@example.com',   'going', '2026-05-12T10:00:00Z'),
  ('r-8', 'demo-005', 'Cara Summit',  'cara@example.com',  'going', '2026-04-22T10:00:00Z'),
  ('r-9', 'demo-007', 'Dan Ridge',    'dan@example.com',   'going', '2026-03-28T10:00:00Z');
