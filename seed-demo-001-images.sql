-- Demo images for demo-001 (Sunrise Ridge Loop) to test the multi-image gallery layout + lightbox.
-- Apply with:
--   wrangler d1 execute hiking_db --local --file=./seed-demo-001-images.sql
-- The matching KV bytes are seeded separately via `wrangler kv key put --local`.

INSERT OR REPLACE INTO event_images (id, event_id, r2_key, is_primary, sort_order, alt_text) VALUES
  ('img-d001-1', 'demo-001', 'event-images/demo-001/hero.jpg',  1, 0, 'Sunrise on the ridge'),
  ('img-d001-2', 'demo-001', 'event-images/demo-001/img-2.jpg', 0, 1, 'Trail through the trees'),
  ('img-d001-3', 'demo-001', 'event-images/demo-001/img-3.jpg', 0, 2, 'Summit view'),
  ('img-d001-4', 'demo-001', 'event-images/demo-001/img-4.jpg', 0, 3, 'Camp at sunset');
